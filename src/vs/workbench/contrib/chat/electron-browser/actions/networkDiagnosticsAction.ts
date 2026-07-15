/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../../base/common/codicons.js';
import { ServicesAccessor } from '../../../../../editor/browser/editorExtensions.js';
import { localize2 } from '../../../../../nls.js';
import { IAgentConnection, IAgentHostDnsResult, IAgentHostNetworkEndpoint, IAgentHostNetworkFetchResult } from '../../../../../platform/agentHost/common/agentService.js';
import { IAgentHostConnectionsService } from '../../../../../platform/agentHost/common/agentHostConnectionsService.js';
import { Categories } from '../../../../../platform/action/common/actionCommonCategories.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { INativeHostService, IOSProxy } from '../../../../../platform/native/common/native.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { ChatContextKeys } from '../../common/actions/chatContextKeys.js';

export function registerNetworkDiagnosticsAction(): void {
	registerAction2(NetworkDiagnosticsAction);
}

async function collectNetworkDiagnostics(connectionsService: IAgentHostConnectionsService, nativeHostService: INativeHostService): Promise<string> {
	const connections = connectionsService.connections;
	const remoteCount = connections.filter(c => !c.isAmbient).length;

	let output = '# Agent Host Network Diagnostics\n\n';
	output += `- Connections: ${connections.length} (1 ambient, ${remoteCount} remote)\n`;
	output += 'Connectivity probes run inside each agent host process (local or remote), so results reflect the environment the Copilot SDK actually connects from.\n\n';

	for (const info of connections) {
		const heading = info.isAmbient ? 'Ambient agent host' : `Remote: ${info.name}`;
		output += `## ${heading}\n\n`;
		if (info.address) {
			output += `- address: ${info.address}\n`;
		}
		if (!info.connection) {
			output += '- Not connected.\n\n';
			continue;
		}
		try {
			output += await formatConnectionNetworkDiagnostics(info.connection, nativeHostService);
		} catch (err) {
			output += `- Failed to run network diagnostics: ${err instanceof Error ? err.message : String(err)}\n\n`;
		}
	}

	return output;
}

async function formatConnectionNetworkDiagnostics(connection: IAgentConnection, nativeHostService: INativeHostService): Promise<string> {
	const info = await connection.getNetworkDiagnosticsInfo();

	let output = '';
	output += `- Agent host version: ${info.version}\n`;
	output += `- OS: ${info.os} (${info.arch})\n`;
	output += `- Account: ${info.account ?? '(unknown)'}\n`;
	output += `- Proxy settings: ${formatKeyValues(info.proxySettings)}\n`;
	output += `- Proxy environment: ${formatKeyValues(info.proxyEnv)}\n\n`;

	const probes = await Promise.all(info.endpoints.map(async endpoint => ({
		endpoint,
		result: await connection.diagnosticsFetch(endpoint.url),
	})));
	for (const { endpoint, result } of probes) {
		output += await formatEndpointSection(endpoint, result, nativeHostService);
	}
	return output;
}

function formatKeyValues(values: Readonly<Record<string, string>>): string {
	const entries = Object.entries(values);
	return entries.length ? entries.map(([key, value]) => `${key}=${value}`).join(', ') : '(none)';
}

async function formatEndpointSection(endpoint: IAgentHostNetworkEndpoint, result: IAgentHostNetworkFetchResult, nativeHostService: INativeHostService): Promise<string> {
	let output = `### ${endpoint.name}\n\n`;
	output += `- URL: ${result.url}\n`;
	output += `- DNS IPv4: ${formatDnsResult(result.dnsIpv4)}\n`;
	output += `- DNS IPv6: ${formatDnsResult(result.dnsIpv6)}\n`;
	output += `- Proxy: ${result.proxyUrl ?? 'None'}\n`;
	try {
		const proxies = await nativeHostService.resolveProxyWithPackage(result.url);
		output += `- Local OS proxy (@vscode/os-proxy-resolver): ${formatProxies(proxies)}\n`;
	} catch (err) {
		output += `- Local OS proxy (@vscode/os-proxy-resolver): error: ${err instanceof Error ? err.message : String(err)}\n`;
	}
	output += `- Reachability: ${formatReachability(endpoint, result)}\n\n`;
	return output;
}

function formatProxies(proxies: readonly IOSProxy[]): string {
	return proxies.length ? proxies.map(proxy => proxy.host ? `${proxy.kind} ${proxy.host}` : proxy.kind).join(', ') : '(none)';
}

function formatDnsResult(dns: IAgentHostDnsResult | undefined): string {
	if (!dns) {
		return 'n/a';
	}
	return dns.address
		? `${dns.address} (${dns.durationMs} ms)`
		: `error (${dns.durationMs} ms): ${dns.error ?? 'unknown'}`;
}

function formatReachability(endpoint: IAgentHostNetworkEndpoint, result: IAgentHostNetworkFetchResult): string {
	// allow-any-unicode-next-line
	const PASS_MARK = '✓', FAIL_MARK = '✗';
	const duration = result.durationMs !== undefined ? ` (${result.durationMs} ms)` : '';
	if (result.error !== undefined) {
		return `${FAIL_MARK} ${result.error}${duration}`;
	}
	const connectVia = result.proxyUrl && /^https?:/i.test(result.proxyUrl) ? 'proxy' : 'direct';
	const expectedStatus = endpoint.expectedStatus ?? 200;
	const failures: string[] = [];
	if (result.statusCode !== expectedStatus) {
		failures.push(`status ${result.statusCode ?? '?'} (expected ${expectedStatus})`);
	}
	if (endpoint.expectedContent && !(result.body ?? '').includes(endpoint.expectedContent)) {
		failures.push(`missing "${endpoint.expectedContent}"`);
	}
	return failures.length
		? `${FAIL_MARK} ${failures.join(', ')} via ${connectVia}${duration}`
		: `${PASS_MARK} ${result.statusCode} via ${connectVia}${duration}`;
}

class NetworkDiagnosticsAction extends Action2 {
	static readonly ID = 'workbench.action.chat.agentHostNetworkDiagnostics';

	constructor() {
		super({
			id: NetworkDiagnosticsAction.ID,
			title: localize2('workbench.action.chat.agentHostNetworkDiagnostics.label', "Network Diagnostics"),
			icon: Codicon.plug,
			category: Categories.Developer,
			f1: true,
			precondition: ChatContextKeys.enabled
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const editorService = accessor.get(IEditorService);
		const connectionsService = accessor.get(IAgentHostConnectionsService);
		const nativeHostService = accessor.get(INativeHostService);

		const contents = await collectNetworkDiagnostics(connectionsService, nativeHostService);
		await editorService.openEditor({
			resource: undefined,
			contents,
			languageId: 'markdown',
			options: {
				pinned: true
			}
		});
	}
}

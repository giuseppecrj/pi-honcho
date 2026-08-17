// Adapted from pi-hermes-memory's MIT-licensed content scanner.
// See THIRD_PARTY_NOTICES.md for the upstream notice.

const THREATS = [
	/ignore\s+(previous|all|above|prior)\s+instructions/i,
	/you\s+are\s+now\s+/i,
	/do\s+not\s+tell\s+the\s+user/i,
	/system\s+prompt\s+override/i,
	/disregard\s+(your|all|any)\s+(instructions|rules|guidelines)/i,
	/curl\s+[^\n]*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/i,
	/wget\s+[^\n]*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/i,
	/cat\s+[^\n]*(\.env|credentials|\.netrc|\.pgpass|\.npmrc|\.pypirc)/i,
	/authorized_keys/i,
	/(?:\$HOME|~)\/\.ssh/i,
];

const SECRETS = [
	/\b(?:sk-ant-api|sk-or-v1-|sk-|ghp_|ghu_|xoxb-|xapp-|ntn_)\S{10,}\b/,
	/\bAKIA[0-9A-Z]{16}\b/,
	/\bBearer\s+\S{20,}\b/i,
	/-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----/,
	/\b(?:ANTHROPIC_API_KEY|OPENAI_API_KEY|OPENROUTER_API_KEY|GITHUB_TOKEN|AWS_SECRET_ACCESS_KEY|DATABASE_URL)\b/,
	/\b(?:password|secret|token|credential|api[_ -]?key)\s*[=:]\s*\S{6,}/i,
];

const INVISIBLE = new Set([
	"\u200b",
	"\u200c",
	"\u200d",
	"\u2060",
	"\ufeff",
	"\u202a",
	"\u202b",
	"\u202c",
	"\u202d",
	"\u202e",
]);

/** Returns a blocked reason, or undefined when content is safe. */
export function scanContent(content: string): string | undefined {
	for (const char of content)
		if (INVISIBLE.has(char))
			return "Blocked: content contains invisible unicode (possible injection).";
	for (const pattern of THREATS)
		if (pattern.test(content))
			return "Blocked: content contains an injection or exfiltration pattern.";
	for (const pattern of SECRETS)
		if (pattern.test(content))
			return "Blocked: content looks like a credential or secret.";
	return undefined;
}

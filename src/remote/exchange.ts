export interface FinalizedExchange {
	operationId: string;
	userText: string;
	assistantText: string;
}

const SECRET_PATTERNS = [
	/-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----/i,
	/(?:api[_-]?key|token|secret(?:[_-]?(?:key|access[_-]?key))?|password)\s*[:=]\s*["']?[^\s"']{8,}/i,
	/\bauthorization\s*:\s*bearer\s+[a-z0-9._~+/=-]{8,}/i,
	/\b(?:sk|ghp|github_pat)_[A-Za-z0-9_-]{16,}\b/,
	/\bsk(?:-proj)?-[A-Za-z0-9_-]{16,}\b/,
];

export function safeExchange(
	exchange: FinalizedExchange,
): FinalizedExchange | undefined {
	if (!exchange.userText.trim() || !exchange.assistantText.trim())
		return undefined;
	if (
		SECRET_PATTERNS.some(
			(pattern) =>
				pattern.test(exchange.userText) || pattern.test(exchange.assistantText),
		)
	)
		return undefined;
	return exchange;
}

export function chunkText(text: string, maximumCharacters = 8_000): string[] {
	const characters = Array.from(text);
	return Array.from(
		{ length: Math.ceil(characters.length / maximumCharacters) },
		(_, index) =>
			characters
				.slice(index * maximumCharacters, (index + 1) * maximumCharacters)
				.join(""),
	);
}

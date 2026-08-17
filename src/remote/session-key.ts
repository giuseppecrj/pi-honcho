import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function repositorySessionKey(
	cwd: string,
	peerName: string,
): Promise<string> {
	let identity = cwd;
	try {
		const { stdout } = await execFileAsync(
			"git",
			["-C", cwd, "remote", "get-url", "origin"],
			{
				timeout: 1_000,
			},
		);
		identity = stdout.trim() || cwd;
	} catch {
		// A non-git directory is intentionally isolated by its absolute path.
	}
	const input = `repo-v2:${peerName.length}:${peerName}:${identity.length}:${identity}`;
	return `repo-v2-${createHash("sha256").update(input).digest("hex").slice(0, 24)}`;
}

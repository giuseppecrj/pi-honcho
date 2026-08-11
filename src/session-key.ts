import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function repositorySessionKey(cwd: string): Promise<string> {
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
	return `repo-${createHash("sha256").update(identity).digest("hex").slice(0, 24)}`;
}

/** App-owned Node is an executable dependency, not the restricted macOS launcher. */
export function appOwnedNodeCommand(path: string, shell: "powershell" | "bash" = "powershell"): string {
  const normalized = path.replaceAll("\\", "/");
  // Use literal shell quoting for every legal Windows profile name. The desktop,
  // not provider configuration or inherited environment, supplies this path.
  if (!/^[A-Za-z]:\/.+\/node\.exe$/.test(normalized) || /["\x00-\x1f<>|?*]/.test(normalized) || normalized.slice(2).includes(":") || normalized.split("/").some(part => part === ".." || part === ".")) {
    throw new Error("Graph-authoring Node must be a shell-safe absolute Windows node.exe path.");
  }
  const quoted = shell === "powershell" ? `'${normalized.replaceAll("'", "''")}'` : `'${normalized.replaceAll("'", `'"'"'`)}'`;
  return `${shell === "powershell" ? "& " : ""}${quoted} --input-type=module`;
}
export function appOwnedNodeInstructions(path: string, shell: "powershell" | "bash" = "powershell"): string {
  return `Run exactly ${appOwnedNodeCommand(path, shell)}; do not resolve Node.js from PATH. Pass the program through standard input. ${shell === "powershell" ? "In PowerShell first set $OutputEncoding = [System.Text.UTF8Encoding]::new($false) to preserve Unicode source, then use a single-quoted here-string (@' on its own line, the program, then '@ on its own line) piped to this exact command; do not use Bash heredoc syntax in PowerShell." : "Use a shell-native single-quoted here-document delimited by RELAYER_GRAPH_PROGRAM."} Do not expand environment variables in the program, use --eval, or write a script file. This is the app-owned Node executable under the ordinary configured provider permission policy.`;
}

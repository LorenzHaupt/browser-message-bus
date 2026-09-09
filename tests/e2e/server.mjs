import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { cwd } from "node:process";

const port = Number(process.argv[2]);
if (!Number.isInteger(port)) {
  throw new Error("Expected a port argument.");
}

const root = resolve(cwd());
const mime = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".json", "application/json; charset=utf-8"]
]);

createServer((request, response) => {
  const rawPath = decodeURIComponent(new URL(request.url ?? "/", `http://127.0.0.1:${port}`).pathname);
  const relative = normalize(rawPath).replace(/^([/\\])+/, "");
  const filePath = resolve(join(root, relative || "tests/e2e/fixtures/host.html"));
  const insideRoot = filePath === root || filePath.startsWith(`${root}${sep}`);

  if (!insideRoot || !existsSync(filePath) || !statSync(filePath).isFile()) {
    response.writeHead(404);
    response.end("Not found");
    return;
  }

  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Type", mime.get(extname(filePath)) ?? "application/octet-stream");
  createReadStream(filePath).pipe(response);
}).listen(port, "127.0.0.1", () => {
  console.log(`BMB test server listening on http://127.0.0.1:${port}`);
});

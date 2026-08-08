import http from "node:http";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import Busboy from "busboy";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { zipSync } from "fflate";

const run = promisify(execFile);
const projectRoot = path.resolve(process.cwd(), "..");
const python = process.env.AUDIOBOOK_PYTHON || "C:\\Users\\Mushfiq\\miniconda3\\envs\\animal-farm-splitter\\python.exe";
const script = path.join(projectRoot, "pdf_audiobook_splitter.py");

async function zipOutput(directory) {
  const files = {};
  for (const name of await readdir(directory)) {
    if (name.endsWith(".mp3") || name === "manifest.json") files[name] = await readFile(path.join(directory, name));
  }
  return zipSync(files, { level: 1 });
}

function collectUpload(request, root) {
  return new Promise((resolve, reject) => {
    const fields = {};
    const files = {};
    const writes = [];
    const parser = Busboy({ headers: request.headers, limits: { fileSize: 2 * 1024 * 1024 * 1024 } });
    parser.on("field", (name, value) => { fields[name] = value; });
    parser.on("file", (name, stream, info) => {
      const destination = path.join(root, name === "pdf" ? "book.pdf" : "book.mp3");
      files[name] = destination;
      const chunks = [];
      stream.on("data", (chunk) => chunks.push(chunk));
      writes.push(new Promise((resolveWrite, rejectWrite) => {
        stream.on("end", () => {
          writeFile(destination, Buffer.concat(chunks)).then(resolveWrite).catch(rejectWrite);
        });
      }));
    });
    parser.on("error", reject);
    parser.on("finish", () => Promise.all(writes).then(() => resolve({ fields, files })).catch(reject));
    request.pipe(parser);
  });
}

function sendJson(response, status, data) {
  response.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  response.end(JSON.stringify(data));
}

const server = http.createServer(async (request, response) => {
  if (request.method === "OPTIONS") {
    response.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" });
    response.end();
    return;
  }
  if (request.method !== "POST" || request.url !== "/api/process") {
    sendJson(response, 404, { error: "Local processing endpoint not found." });
    return;
  }
  const jobRoot = path.join(projectRoot, ".chapter-cut-jobs", randomUUID());
  const input = path.join(jobRoot, "input");
  const output = path.join(jobRoot, "output");
  try {
    await mkdir(input, { recursive: true });
    await mkdir(output, { recursive: true });
    const { fields, files } = await collectUpload(request, input);
    if (!files.pdf || !files.audio) throw new Error("Both a PDF and an audiobook are required.");
    const template = fields.template || "[{I2}|{T}]_{B}__C[{C2}|{CT}]__P[{P}|{PT}].mp3";
    await run(python, [script, "--pdf", files.pdf, "--audio", files.audio, "--output", output, "--model", "small", "--device", "cuda", "--minutes", fields.minutes || "10", "--mode", fields.mode || "smart", "--naming-template", template], { cwd: projectRoot, maxBuffer: 1024 * 1024 * 4 });
    const zip = zipOutput(output);
    const data = await zip;
    response.writeHead(200, { "Content-Type": "application/zip", "Content-Disposition": "attachment; filename=chapter-cut-export.zip", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" });
    response.end(Buffer.from(data));
  } catch (error) {
    sendJson(response, 500, { error: error instanceof Error ? error.message.slice(-1800) : "The processing job failed." });
  } finally {
    await rm(jobRoot, { recursive: true, force: true }).catch(() => undefined);
  }
});

server.listen(3001, "127.0.0.1", () => console.log("chapter.cut processing service listening on http://127.0.0.1:3001"));

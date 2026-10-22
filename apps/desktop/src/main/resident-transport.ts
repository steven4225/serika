import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, lstat, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import { dirname, join, resolve } from "node:path";
import { tryAcquireFlock } from "@serika/assistant";
import { MAX_RESIDENT_FRAME_BYTES, MAX_RESIDENT_PENDING, RESIDENT_BRIDGE_METHODS, RESIDENT_HOST_METHODS, RESIDENT_VERSION, type RemoteRuntimeBridge, type RemoteRuntimeMethods, type ResidentClientFrame, type ResidentScope, type ResidentServerFrame, type ResidentState } from "./resident-protocol.js";
import type { DesktopRuntime } from "./desktop-runtime.js";
import type { Send } from "./runtime-bridge.js";
import { safeStartupError } from "./desktop-env.js";

export interface ResidentPaths { directory: string; socket: string; token: string }
export function createResidentPaths(applicationHome: string, socketOverride?: string): ResidentPaths {
  const directory = join(resolve(applicationHome), "resident");
  return { directory, socket: socketOverride ?? join(directory, "runtime.sock"), token: join(directory, "auth-token") };
}
async function privateEntry(path: string, directory: boolean): Promise<void> {
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()) ||
    (process.getuid && stat.uid !== process.getuid()) || (stat.mode & 0o077) !== 0) {
    throw new Error("助手服务凭据目录或文件权限不安全，请核对本机用户配置");
  }
}
export async function prepareResidentCredentials(paths: ResidentPaths): Promise<string> {
  await mkdir(paths.directory, { recursive: true, mode: 0o700 });
  await privateEntry(paths.directory, true);
  try { await writeFile(paths.token, randomBytes(32).toString("hex"), { flag: "wx", mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  return readResidentCredentials(paths);
}
export async function readResidentCredentials(paths: ResidentPaths): Promise<string> {
  await privateEntry(paths.directory, true);
  await privateEntry(paths.token, false);
  const token = (await readFile(paths.token, "utf8")).trim();
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error("助手服务凭据无效");
  return token;
}
function equalSecret(a: unknown, b: string): boolean {
  if (typeof a !== "string") return false;
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
function sameScope(a: ResidentScope, b: ResidentScope): boolean {
  return !!a && typeof a === "object" && ["applicationHome", "configPath"].every(key =>
    typeof a[key as keyof ResidentScope] === "string" && resolve(a[key as keyof ResidentScope]) === resolve(b[key as keyof ResidentScope]));
}
function sendFrame(socket: Socket, frame: ResidentServerFrame | ResidentClientFrame): void {
  const data = JSON.stringify(frame) + "\n";
  if (Buffer.byteLength(data) > MAX_RESIDENT_FRAME_BYTES || socket.writableLength > MAX_RESIDENT_FRAME_BYTES * 2) {
    socket.destroy(new Error("助手连接数据超过限额，请重新读取状态")); return;
  }
  if (!socket.destroyed) socket.write(data);
}
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const RESPONSE_CHUNK_BYTES = 64 * 1024;
async function sendResponse(socket: Socket, frame: Extract<ResidentServerFrame, { type: "response" }>): Promise<void> {
  const data = Buffer.from(JSON.stringify(frame));
  if (data.length + 1 <= MAX_RESIDENT_FRAME_BYTES) { sendFrame(socket, frame); return; }
  if (data.length > MAX_RESPONSE_BYTES) throw new Error("单次结果超过读取限额，请使用分页入口");
  const count = Math.ceil(data.length / RESPONSE_CHUNK_BYTES);
  for (let index = 0; index < count; index++) {
    if (socket.destroyed) return; // A read response is never retried as an operation.
    const chunk: ResidentServerFrame = { type: "response-chunk", id: frame.id, index, count,
      data: data.subarray(index * RESPONSE_CHUNK_BYTES, (index + 1) * RESPONSE_CHUNK_BYTES).toString("base64") };
    // Respect socket backpressure instead of buffering the entire history.
    await new Promise<void>((done, reject) => socket.write(JSON.stringify(chunk) + "\n", error => error ? reject(error) : done()));
  }
}
function readFrames(socket: Socket, onFrame: (value: unknown) => void): void {
  let pending = Buffer.alloc(0);
  socket.on("data", (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk]);
    let end: number;
    while ((end = pending.indexOf(10)) >= 0) {
      if (end > MAX_RESIDENT_FRAME_BYTES) { socket.destroy(); return; }
      const frame = pending.subarray(0, end); pending = pending.subarray(end + 1);
      try { onFrame(JSON.parse(frame.toString("utf8"))); }
      catch { socket.destroy(); return; }
      if (socket.destroyed) return;
    }
    if (pending.length > MAX_RESIDENT_FRAME_BYTES) socket.destroy();
  });
}
async function removeStaleSocket(path: string): Promise<void> {
  try {
    const stat = await lstat(path);
    if (!stat.isSocket() || (process.getuid && stat.uid !== process.getuid())) throw new Error("助手服务路径被非套接字占用");
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  const active = await new Promise<boolean>((resolveProbe, reject) => {
    const socket = createConnection(path);
    socket.once("connect", () => { socket.destroy(); resolveProbe(true); });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ECONNREFUSED" || error.code === "ENOENT") resolveProbe(false); else reject(error);
    });
    socket.setTimeout(1000, () => { socket.destroy(); reject(new Error("助手服务探测超时，不会删除现有入口")); });
  });
  if (active) throw new Error("助手服务已经运行，不会创建第二个执行宿主");
  await unlink(path).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; });
}

export interface ResidentServer {
  runtime: DesktopRuntime;
  /** Stop accepting clients only. Runtime ownership and shutdown stay with the process entry. */
  close(): Promise<void>;
}
export async function startResidentServer(options: {
  paths: ResidentPaths; scope: ResidentScope;
  createRuntime: (send: Send) => Promise<DesktopRuntime>;
  onStop?: () => void;
}): Promise<ResidentServer> {
  const token = await prepareResidentCredentials(options.paths);
  const safeError = (error: unknown) => safeStartupError(error, { ...process.env, SERIKA_RESIDENT_TOKEN: token }).replace(/^Runtime 无法启动：/, "");
  const owner = await tryAcquireFlock(join(options.paths.directory, "transport.lock"));
  if (!owner) throw new Error("助手服务已经运行，不会创建第二个执行宿主");
  try {
    await mkdir(dirname(options.paths.socket), { recursive: true, mode: 0o700 });
    await privateEntry(dirname(options.paths.socket), true);
    if (process.platform === "darwin" && Buffer.byteLength(options.paths.socket) > 103) throw new Error("助手服务套接字路径过长");
    await removeStaleSocket(options.paths.socket);
  } catch (error) { await owner.release(); throw error; }
  const clients = new Set<Socket>();
  const connections = new Set<Socket>();
  let stopping = false, requestsInFlight = 0;
  let runtime: DesktopRuntime | undefined;
  let cached: ResidentState | undefined;
  const state = (): ResidentState => {
    if (!runtime) throw new Error("助手正在启动");
    if (stopping && cached) return cached;
    const info = runtime.info();
    try { cached = { info, snapshot: runtime.current.snapshot() }; }
    catch { if (cached) cached = { ...cached, info }; else throw new Error("助手尚未连接"); }
    return cached!;
  };
  const send: Send = message => {
    if (!runtime) return; // Initial assembly is recovered through the handshake snapshot.
    const current = state();
    if (message.type === "state") current.snapshot = { ...current.snapshot, state: message.state };
    const safeMessage = message.type === "error" ? { ...message, message: safeError(new Error(message.message)) } : message;
    for (const socket of clients) sendFrame(socket, { type: "event", message: safeMessage, state: current });
  };
  // Reserve the socket before creating a Controller, so two processes cannot own it.
  const server = createServer(socket => {
    if (connections.size >= 16) { socket.destroy(); return; }
    connections.add(socket);
    socket.on("error", () => undefined);
    let authenticated = false, pending = 0, lastRequestId = 0;
    const helloTimeout = setTimeout(() => socket.destroy(), 5000); helloTimeout.unref();
    socket.on("close", () => { clearTimeout(helloTimeout); clients.delete(socket); connections.delete(socket); });
    readFrames(socket, raw => {
      if (!raw || typeof raw !== "object") { socket.destroy(); return; }
      const frame = raw as ResidentClientFrame;
      if (!authenticated) {
        if (frame.type !== "hello" || frame.version !== RESIDENT_VERSION || !equalSecret(frame.token, token) || !sameScope(frame.scope, options.scope)) {
          sendFrame(socket, { type: "rejected", error: "助手服务身份或凭据不匹配" }); socket.end(); return;
        }
        if (!runtime) { sendFrame(socket, { type: "rejected", error: "助手服务仍在启动，请稍后连接" }); socket.end(); return; }
        if (stopping) { sendFrame(socket, { type: "rejected", error: "助手服务正在停止，请等待服务恢复后重新连接" }); socket.end(); return; }
        authenticated = true; clearTimeout(helloTimeout); clients.add(socket);
        sendFrame(socket, { type: "ready", state: state() }); return;
      }
      if (frame.type !== "request" || typeof frame.id !== "string" || !/^[1-9][0-9]{0,15}$/.test(frame.id) || !Number.isSafeInteger(Number(frame.id)) || Number(frame.id) <= lastRequestId || !Array.isArray(frame.args) || frame.args.length > 8 || pending >= MAX_RESIDENT_PENDING) { socket.destroy(); return; }
      lastRequestId = Number(frame.id);
      const request = frame;
      if (request.target === "state" && request.method === "stopHost" && options.onStop) {
        const lifecycle = runtime!.getLifecycleStatus();
        if (stopping || requestsInFlight > 0 || state().snapshot.state.kind !== "idle" || lifecycle.pomodoroRunning) {
          sendFrame(socket, { type: "response", id: request.id, ok: false, error: "请先结束当前执行和番茄钟，再停止助手服务", state: state() }); return;
        }
        stopping = true;
        void runtime!.shutdown().then(() => {
          const response: ResidentServerFrame = { type: "response", id: request.id, ok: true, value: null, state: cached! };
          socket.write(JSON.stringify(response) + "\n", () => options.onStop?.());
        }, () => {
          const message = "助手服务未能正常停止，连接已不可用；正在退出以恢复服务，不会重做任务";
          cached = { info: { ...cached!.info, runtimeRecovery: { state: "failed", message } }, snapshot: { ...cached!.snapshot, canSubmit: false, canSteer: false } };
          const response: ResidentServerFrame = { type: "response", id: request.id, ok: false, error: message, state: cached };
          // A partly disposed runtime must not receive new work or survive forever.
          socket.write(JSON.stringify(response) + "\n", () => options.onStop?.());
        });
        return;
      }
      const allowed = request.target === "state" && request.method === "refresh" ||
        request.target === "host" && (RESIDENT_HOST_METHODS as readonly string[]).includes(request.method) ||
        request.target === "current" && (RESIDENT_BRIDGE_METHODS as readonly string[]).includes(request.method);
      if (!allowed) { sendFrame(socket, { type: "response", id: request.id, ok: false, error: "不支持的助手请求", state: state() }); return; }
      if (stopping) { sendFrame(socket, { type: "response", id: request.id, ok: false, error: "助手服务正在停止", state: cached! }); return; }
      pending++;
      requestsInFlight++;
      void (async () => {
        try {
          let value: unknown;
          if (request.target === "state") value = null;
          else {
            const target = request.target === "host" ? runtime! : runtime!.current;
            const method = Reflect.get(target, request.method) as (...args: unknown[]) => unknown;
            value = await method.apply(target, request.args);
          }
          await sendResponse(socket, { type: "response", id: request.id, ok: true, value, state: state() });
        } catch (error) {
          const message = safeError(error);
          sendFrame(socket, { type: "response", id: request.id, ok: false, error: message, state: state() });
        } finally { pending--; requestsInFlight--; }
      })();
    });
  });
  try {
    await new Promise<void>((done, reject) => { server.once("error", reject); server.listen(options.paths.socket, () => { server.removeListener("error", reject); done(); }); });
    await chmod(options.paths.socket, 0o600);
    runtime = await options.createRuntime(send);
    const info = runtime.info();
    if (!info.configPath || resolve(info.configPath) !== resolve(options.scope.configPath)) throw new Error("助手实际配置与常驻服务身份不匹配");
    state();
  } catch (error) {
    for (const client of connections) client.destroy();
    if (server.listening) await new Promise<void>(done => server.close(() => done()));
    try { await runtime?.shutdown(); } finally { await owner.release(); }
    throw error;
  }
  return { runtime, close: async () => {
    for (const client of connections) client.destroy();
    try { await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done())); }
    finally { await owner.release(); }
  } };
}

export class ResidentClient {
  #chunks = new Map<string, { count: number; next: number; bytes: number; chunks: Buffer[] }>();
  #socket!: Socket;
  #state!: ResidentState;
  #connected = false;
  #connecting: Promise<void> | undefined;
  #sequence = 0;
  #pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  readonly current: RemoteRuntimeBridge;
  readonly #options: { paths: ResidentPaths; scope: ResidentScope; send: Send };
  private constructor(options: { paths: ResidentPaths; scope: ResidentScope; send: Send }) {
    this.#options = options;
    this.current = new Proxy({ snapshot: () => this.snapshot() }, { get: (target, key) => {
      if (key === "snapshot") return target.snapshot;
      if (typeof key === "string" && (RESIDENT_BRIDGE_METHODS as readonly string[]).includes(key)) return (...args: unknown[]) => this.#request("current", key, args);
      return undefined;
    } }) as RemoteRuntimeBridge;
    for (const method of RESIDENT_HOST_METHODS) Object.defineProperty(this, method, { value: (...args: unknown[]) => this.#request("host", method, args) });
  }
  static async connect(options: { paths: ResidentPaths; scope: ResidentScope; send: Send }): Promise<ResidentClient & RemoteRuntimeMethods> {
    const client = new ResidentClient(options); await client.#connect(); return client as ResidentClient & RemoteRuntimeMethods;
  }
  get connected(): boolean { return this.#connected; }
  info() {
    return this.#connected ? this.#state.info : { ...this.#state.info, runtimeRecovery: { state: "failed" as const, message: "助手连接已断开，请重新连接；未自动重发任何请求" } };
  }
  snapshot() {
    if (!this.#connected) throw new Error("助手连接已断开，缓存状态不能用于操作");
    return this.#state.snapshot;
  }
  async refresh(): Promise<void> { await this.#request("state", "refresh", []); }
  async requestStop(): Promise<void> { await this.#request("state", "stopHost", []); }
  /** Explicit transport reconnect. Never retries or resends a previous operation. */
  async reconnect(): Promise<void> { if (!this.#connected) await this.#connect(); else await this.refresh(); }
  /** Detach the UI only. This must not call Controller.shutdown or cancel. */
  detach(): void { this.#socket.destroy(); this.#disconnected(); }
  #disconnected(): void {
    const wasConnected = this.#connected;
    this.#connected = false;
    const error = new Error("助手连接已断开，请核对执行记录后重新连接；请求可能已执行，不会自动重发");
    for (const request of this.#pending.values()) request.reject(error);
    this.#pending.clear();
    this.#chunks.clear();
    if (wasConnected) this.#options.send({ type: "error", message: error.message });
  }
  async #connect(): Promise<void> {
    if (this.#connecting) return this.#connecting;
    const attempt = this.#openConnection();
    this.#connecting = attempt;
    try { await attempt; } finally { if (this.#connecting === attempt) this.#connecting = undefined; }
  }
  async #openConnection(): Promise<void> {
    const token = await readResidentCredentials(this.#options.paths);
    await new Promise<void>((done, reject) => {
      let ready = false;
      const socket = createConnection(this.#options.paths.socket); this.#socket = socket;
      const timer = setTimeout(() => { socket.destroy(); reject(new Error("助手服务连接超时")); }, 5000); timer.unref();
      socket.once("connect", () => sendFrame(socket, { type: "hello", version: RESIDENT_VERSION, token, scope: this.#options.scope }));
      socket.on("error", error => { if (!ready) reject(error); });
      socket.on("close", () => { clearTimeout(timer); if (!ready) reject(new Error("助手服务连接未建立")); if (this.#socket === socket) this.#disconnected(); });
      const acceptFrame = (raw: unknown): void => {
        if (this.#socket !== socket) return;
        const frame = raw as ResidentServerFrame;
        if (!frame || typeof frame !== "object") { socket.destroy(); return; }
        if (frame.type === "rejected") { reject(new Error(frame.error)); socket.destroy(); return; }
        if (frame.type === "ready" && !ready) {
          ready = true; clearTimeout(timer); this.#state = frame.state; this.#connected = true; done(); return;
        }
        if (!ready) { socket.destroy(); return; }
        if (frame.type === "response-chunk") {
          if (!this.#pending.has(frame.id) || !Number.isSafeInteger(frame.count) || frame.count < 1 || frame.count > MAX_RESPONSE_BYTES / RESPONSE_CHUNK_BYTES ||
            !Number.isSafeInteger(frame.index) || typeof frame.data !== "string" || frame.data.length > RESPONSE_CHUNK_BYTES * 2 || !/^[A-Za-z0-9+/]*={0,2}$/.test(frame.data)) { socket.destroy(); return; }
          const assembly = this.#chunks.get(frame.id) ?? { count: frame.count, next: 0, bytes: 0, chunks: [] };
          if (assembly.count !== frame.count || assembly.next !== frame.index) { socket.destroy(); return; }
          const part = Buffer.from(frame.data, "base64");
          assembly.bytes += part.length;
          const totalBytes = [...this.#chunks.entries()].reduce((sum, [id, chunk]) => sum + (id === frame.id ? 0 : chunk.bytes), assembly.bytes);
          if (assembly.bytes > MAX_RESPONSE_BYTES || totalBytes > MAX_RESPONSE_BYTES * 2 || part.length > RESPONSE_CHUNK_BYTES) { socket.destroy(); return; }
          assembly.next++; assembly.chunks.push(part); this.#chunks.set(frame.id, assembly);
          if (assembly.next === assembly.count) {
            this.#chunks.delete(frame.id);
            const complete = JSON.parse(Buffer.concat(assembly.chunks, assembly.bytes).toString("utf8")) as ResidentServerFrame;
            if (complete.type !== "response" || complete.id !== frame.id) { socket.destroy(); return; }
            acceptFrame(complete);
          }
          return;
        }
        if (frame.type === "event") { this.#state = frame.state; this.#options.send(frame.message); }
        else if (frame.type === "response") {
          this.#state = frame.state;
          const request = this.#pending.get(frame.id); this.#pending.delete(frame.id);
          if (frame.ok) request?.resolve(frame.value); else request?.reject(new Error(frame.error));
        }
      };
      readFrames(socket, acceptFrame);
    });
  }
  #request(target: "host" | "current" | "state", method: string, args: unknown[]): Promise<unknown> {
    if (!this.#connected || this.#socket.destroyed) return Promise.reject(new Error("助手连接已断开，请先重新连接"));
    if (this.#pending.size >= MAX_RESIDENT_PENDING) return Promise.reject(new Error("助手请求过多，请等待当前请求完成"));
    const id = String(++this.#sequence);
    return new Promise((resolveRequest, reject) => {
      this.#pending.set(id, { resolve: resolveRequest, reject });
      const safeArgs = [...args];
      // JSON arrays turn undefined into null; omitted optional arguments must stay omitted.
      while (safeArgs.length > 0 && safeArgs.at(-1) === undefined) safeArgs.pop();
      try { sendFrame(this.#socket, { type: "request", id, target, method, args: safeArgs }); }
      catch { this.#pending.delete(id); reject(new Error("助手请求无法编码，未发送")); }
    });
  }
}

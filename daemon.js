// daemon.js
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { ProcessSupervisor } from "./supervisor.js";

const SOCKET_PATH = process.platform === "win32"
    ? "\\\\.\\pipe\\woomy-server-supervisor-ipc"
    : path.join("/tmp", "woomy-server-supervisor.sock");

function cleanSocket() {
    if (process.platform !== "win32" && fs.existsSync(SOCKET_PATH)) {
        try {
            fs.unlinkSync(SOCKET_PATH);
        } catch { }
    }
}
cleanSocket();

if (process.platform !== "win32" && fs.existsSync(SOCKET_PATH)) {
    fs.unlinkSync(SOCKET_PATH);
}

// Configure the multi-process list
const instancesDir = path.resolve(import.meta.dirname, "instances");
if (!fs.existsSync(instancesDir)) {
    fs.mkdirSync(instancesDir, { recursive: true });
}

const servers = fs
    .readdirSync(instancesDir, { withFileTypes: true })
    .filter((dir) => dir.isDirectory())
    .map((dir) => dir.name);

const PROCESS_CONFIGS = servers.map((server) => ({
    id: server,
    cwd: path.join(instancesDir, server),
    command: "node",
    args: ["./start.js"],
}));

const processes = new Map();
const clients = new Set();

function broadcast(msg) {
    const payload = JSON.stringify(msg) + "\n";
    for (const client of clients) {
        client.write(payload);
    }
}

// Initialize supervisors
for (const config of PROCESS_CONFIGS) {
    const supervisor = new ProcessSupervisor({
        cwd: config.cwd,
        command: config.command,
        args: config.args,
    });

    processes.set(config.id, supervisor);
}

// Create IPC Server
const server = net.createServer((socket) => {
    clients.add(socket);

    let buffer = "";
    socket.on("data", async (data) => {
        buffer += data.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop();

        for (const line of lines) {
            if (!line.trim()) continue;
            const cmd = JSON.parse(line);
            await handleClientCommand(cmd, socket);
        }
    });

    socket.on("close", () => clients.delete(socket));
    socket.on("error", () => clients.delete(socket));
});

function getState() {
    return Array.from(processes.entries()).map(([id, proc]) => {
        if (Date.now() - proc.startTime > proc.restartDur) proc.restart();

        return ({
            id,
            state: proc.state,
            players: proc.players,
            maxPlayers: proc.maxPlayers,
            serverSpeed: proc.serverSpeed,
            startTime: proc.startTime,
            restartDur: proc.restartDur
        })
    });
}

async function handleClientCommand(cmd, socket) {
    switch (cmd.type) {
        case "GET_STATE": {
            broadcastState();
            break;
        }
        case "START":
            await processes.get(cmd.id)?.start();
            broadcastState();
            break;
        case "STOP":
            await processes.get(cmd.id)?.stop();
            broadcastState();
            break;
        case "RESTART":
            await processes.get(cmd.id)?.restart();
            broadcastState();
            break;
        case "KILL_DAEMON":
            for (const proc of processes.values()) {
                await proc.stop();
            }
            process.exit(0);
    }
}

function broadcastState() {
    broadcast({ type: "STATE_UPDATE", data: getState() });
}

// Clean socket file if daemon terminates unexpectedly
process.on("exit", cleanSocket);
process.on("SIGINT", () => { cleanSocket(); process.exit(0); });
process.on("SIGTERM", () => { cleanSocket(); process.exit(0); });

server.listen(SOCKET_PATH);

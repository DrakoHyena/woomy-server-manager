// cli.js
import net from "node:net";
import { spawn } from "node:child_process";
import path from "node:path";
import readline from "node:readline";
import process from "node:process";
import chalk from "chalk";
import logUpdate from "log-update";

const SOCKET_PATH = process.platform === "win32"
    ? "\\\\.\\pipe\\woomy-server-supervisor-ipc"
    : path.join("/tmp", "woomy-server-supervisor.sock");

// --- Theme Palette (Catppuccin Mocha / Tokyo Night) ---
const theme = {
    bg: "#000000",
    c1: "#270C22",
    c2: "#FC0352",
    c3: "#2F0E29",
    c4: "#EDC4E6",
    text: "#ffffff",
    running: "#23C552",
    stopped: "#ff0000",
};

// --- State Management ---
let processes = [];
let selectedIndex = 0;
let clientSocket = null;

// --- IPC Client & Auto-Daemon Spawner with Polling ---
async function connectToDaemon() {
    const maxAttempts = 20;
    let attempts = 0;
    let daemonSpawned = false;

    return new Promise((resolve) => {
        const tryConnect = () => {
            attempts++;
            const socket = net.createConnection(SOCKET_PATH, () => resolve(socket));

            socket.on("error", () => {
                socket.destroy();

                if (!daemonSpawned) {
                    daemonSpawned = true;
                    const daemon = spawn(process.execPath, [path.join(import.meta.dirname, "daemon.js")], {
                        cwd: import.meta.dirname,
                        detached: true,
                        stdio: "ignore",
                    });
                    daemon.unref();
                }

                if (attempts >= maxAttempts) {
                    restoreTerminal();
                    console.error(chalk.hex(theme.stopped)("Failed to connect to daemon after multiple attempts."));
                    process.exit(1);
                }

                setTimeout(tryConnect, 150);
            });
        };

        tryConnect();
    });
}

// --- Terminal State Containment ---
function setupTerminal() {
    process.stdout.write("\x1b[?1049h\x1b[?25l"); // Enter alternate screen buffer & hide cursor
    readline.emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) {
        process.stdin.setRawMode(true);
    }
    process.stdin.resume();
}

function restoreTerminal() {
    logUpdate.done();
    process.stdout.write("\x1b[?25h\x1b[?1049l"); // Restore cursor & exit alternate buffer
    if (process.stdin.isTTY) {
        process.stdin.setRawMode(false);
    }
    process.stdin.pause();
}

// --- Dimension & Layout Utilities ---
function getWidth() {
    return process.stdout.columns || 80;
}

function getHeight() {
    return process.stdout.rows || 24;
}

// Strips ANSI styling codes to accurately compute visible text length
function visibleLength(str) {
    return String(str).replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "").length;
}

// Centers string within exact target width, handling odd remainder distribution correctly
function center(string, targetWidth) {
    const len = visibleLength(string);
    const totalPad = Math.max(0, targetWidth - len);
    const padLeft = Math.floor(totalPad / 2);
    const padRight = totalPad - padLeft;
    return " ".repeat(padLeft) + string + " ".repeat(padRight);
}

// Partition width cleanly across 3 table columns without fractional pixel drift
function getColWidths(totalWidth) {
    const col1 = Math.floor(totalWidth * 0.2);
    const col2 = Math.floor(totalWidth * 0.2);
    const col3 = Math.floor(totalWidth * 0.2);
    const col4 = Math.floor(totalWidth * 0.22);
    const col5 = totalWidth - col1 - col2 - col3 - col4;
    return [col1, col2, col3, col4, col5];
}

function formatMs(ms) {
    const seconds = Math.floor((ms / 1000) % 60);
    const minutes = Math.floor((ms / (1000 * 60)) % 60);
    const hours = Math.floor(ms / (1000 * 60 * 60));

    return `${hours}:${minutes}:${seconds}`;
}

// --- Render Dashboard ---
function renderUI() {
    const W = getWidth();
    const H = getHeight();
    const [w1, w2, w3, w4, w5] = getColWidths(W);

    const lines = [];

    // 1. Header Banner
    lines.push(chalk.bgHex(theme.c1).hex(theme.c2).bold(center("Woomy Server Manager", W)));
    lines.push(chalk.bgHex(theme.c3)(" ".repeat(W)));

    // 2. Instances Table Header
    const headerRow = center("ID", w1) + center("STATUS", w2) + center("PLAYERS", w3) + center("SERVER SPEED", w4) + center("AUTO RESTART", w5);
    lines.push(chalk.bgHex(theme.c3).hex(theme.text)(headerRow));
    lines.push(chalk.bgHex(theme.c3)(" ".repeat(W)));

    // 3. Instances List
    if (processes.length === 0) {
        lines.push(chalk.bgHex(theme.c3)(" ".repeat(W)));
        lines.push(chalk.bgHex(theme.c3).hex(theme.text)(center("(Connecting to daemon or no instances found...)", W)));
    } else {
        processes.forEach((proc, idx) => {
            const isSelected = idx === selectedIndex;
            const pointer = isSelected ? "> " : "  ";

            const idCol = center(pointer + proc.id, w1);
            const statusCol = center(
                chalk.hex(proc.state === "RUNNING" ? theme.running : theme.stopped).bold("[" + proc.state + "]"),
                w2
            );
            const playersCol = center(`${proc.players}/${proc.maxPlayers}`, w3);
            let speedCol = center(`${proc.serverSpeed}mpst`, w4);
            if (proc.serverSpeed > 33.3) {
                speedCol = chalk.hex(theme.c2)(speedCol)
            } else {
                speedCol = chalk.hex(theme.text)(speedCol)
            }
            const restartCol = center(formatMs(proc.restartDur - (Date.now() - proc.startTime)), w5);
            const rowContent = idCol + statusCol + playersCol + speedCol + restartCol;

            if (isSelected) {
                lines.push(chalk.bgHex(theme.c1).hex(theme.text).bold(rowContent));
            } else {
                lines.push(chalk.bgHex(theme.c3).hex(theme.text)(rowContent));
            }
        });
    }

    lines.push(chalk.bgHex(theme.c3)(" ".repeat(W)));
    lines.push(chalk.bgHex(theme.c3)(" ".repeat(W)));

    // 4. Info / Log Hint Pane
    const selectedProc = processes[selectedIndex];
    lines.push(chalk.bgHex(theme.c3).hex(theme.text)(center("Target: " + (selectedProc ? selectedProc.id : "None"), W)));
    if (selectedProc) {
        lines.push(chalk.bgHex(theme.c3).hex(theme.text)(center(`Logs streaming to: ./logs/${selectedProc.id}-*.log`, W)));
    }

    // 5. Footer Controls
    lines.push(chalk.bgHex(theme.c3)(" ".repeat(W)));
    lines.push(chalk.bgHex(theme.c1).hex(theme.c2)(
        center("[↑/↓] Select | [s] Start | [k] Stop | [r] Restart | [d] Detach | [q] Quit", W)
    ));

    // 6. Vertical Centering Padding
    const contentHeight = lines.length;
    const padTop = Math.max(0, Math.floor((H - contentHeight) / 2));
    const padBottom = Math.max(0, H - contentHeight - padTop);

    const emptyBgLine = chalk.bgHex(theme.bg)(" ".repeat(W));
    const topPadding = Array(padTop).fill(emptyBgLine);
    const bottomPadding = Array(padBottom).fill(emptyBgLine);

    // Paint without screen flashing
    logUpdate([...topPadding, ...lines, ...bottomPadding].join("\n"));
}

// --- Main Entry ---
async function main() {
    setupTerminal();
    renderUI();

    // Catch-all emergency exits
    process.on("exit", restoreTerminal);
    process.on("SIGINT", () => { restoreTerminal(); process.exit(0); });
    process.on("uncaughtException", (err) => {
        restoreTerminal();
        console.error("Fatal CLI Error:", err);
        process.exit(1);
    });

    clientSocket = await connectToDaemon();

    // Request initial state
    clientSocket.write(JSON.stringify({ type: "GET_STATE" }) + "\n");

    // IPC Stream
    const rl = readline.createInterface({ input: clientSocket, crlfDelay: Infinity });
    rl.on("line", (line) => {
        if (!line.trim()) return;
        try {
            const msg = JSON.parse(line);
            if (msg.type === "STATE" || msg.type === "STATE_UPDATE") {
                processes = msg.data;
                renderUI();
            }
        } catch { }
    });

    // Keyboard Navigation
    process.stdin.on("keypress", (_, key) => {
        if (!key) return;

        if (key.ctrl && key.name === "c") {
            restoreTerminal();
            process.exit(0);
        }

        if (key.name === "up" && processes.length > 0) {
            selectedIndex = (selectedIndex - 1 + processes.length) % processes.length;
            renderUI();
        } else if (key.name === "down" && processes.length > 0) {
            selectedIndex = (selectedIndex + 1) % processes.length;
            renderUI();
        } else if (key.name === "s" && processes[selectedIndex]) {
            clientSocket.write(JSON.stringify({ type: "START", id: processes[selectedIndex].id }) + "\n");
        } else if (key.name === "k" && processes[selectedIndex]) {
            clientSocket.write(JSON.stringify({ type: "STOP", id: processes[selectedIndex].id }) + "\n");
        } else if (key.name === "r" && processes[selectedIndex]) {
            clientSocket.write(JSON.stringify({ type: "RESTART", id: processes[selectedIndex].id }) + "\n");
        } else if (key.name === "d") {
            restoreTerminal();
            console.log(chalk.hex(theme.running)("✔ Detached from supervisor. (Instances running in background)"));
            console.log(chalk.hex(theme.c1)("Reattach anytime with: node cli.js\n"));
            process.exit(0);
        } else if (key.name === "q") {
            clientSocket.write(JSON.stringify({ type: "KILL_DAEMON" }) + "\n");
            restoreTerminal();
            process.exit(0);
        }
    });

    process.stdout.on("resize", renderUI);

    // Update the UI every so often
    setInterval(() => {
        if (clientSocket && !clientSocket.destroyed) {
            clientSocket.write(JSON.stringify({ type: "GET_STATE" }) + "\n");
        }
    }, 250);
}

main();

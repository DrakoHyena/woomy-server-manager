import { spawn } from "node:child_process";
import process from "node:process";
import * as fs from "node:fs"

export class ProcessSupervisor {
    /**
     * @param {Object} options
     * @param {string} options.command - The executable or command.
     * @param {string[]} [options.args=[]] - Command line arguments.
     * @param {Object} [options.env={}] - Environment variables.
     * @param {string} [options.cwd=process.cwd()] - Working directory.
     * @param {number} [options.killTimeoutMs=5000] - Time before escalating to SIGKILL.
     */
    constructor(options) {
        this.command = options.command;
        this.args = options.args || [];
        this.env = { ...process.env, ...options.env };
        this.cwd = options.cwd || process.cwd();
        this.killTimeoutMs = options.killTimeoutMs ?? 5_000;
        this.streamLabel = options.cwd.split("/").pop()
        this.writeStream = fs.createWriteStream(`./logs/${this.streamLabel}-${(new Date()).toString()}`)

        this.child = null;
        this.state = "STOPPED"; // "STOPPED" | "RUNNING"

        this.players = 0;
        this.maxPlayers = 99;
        this.serverSpeed = 0;
        this.startTime = Date.now();
        this.restartDur = 14_400_000; // 4 hours

        this._bindSystemSignals();
    }

    // --- Public Controls ---

    async start() {
        if (this.state === "RUNNING") return;
        this.writeStream = fs.createWriteStream(`./logs/${this.streamLabel}-${(new Date).toString()}`)
        this.startTime = Date.now();
        this._spawnProcess();
    }

    async stop(signal = "SIGTERM") {
        if (this.state === "STOPPED") return;


        if (!this.child || !this.child.pid) {
            this.state = "STOPPED";
            return;
        }

        await this._killProcessTree(this.child.pid, signal);
        this.state = "STOPPED";
    }

    async restart() {
        await this.stop();
        await this.start();
    }

    _spawnProcess() {
        // detached: true creates a new process group on POSIX.
        // This allows killing the entire child tree by targeting -PID.
        this.child = spawn(this.command, this.args, {
            cwd: this.cwd,
            env: this.env,
            detached: process.platform !== "win32",
            stdio: ["pipe", "pipe", "pipe", "ipc"],
        });

        const pid = this.child.pid;
        this.state = "RUNNING";

        // Route stdout / stderr with clean formatting
        this.child.stdout.on("data", (data) => this._handleOutput("STDOUT", data));
        this.child.stderr.on("data", (data) => this._handleOutput("STDERR", data));

        this.child.on("message", (msg) => {
            const { type, players, maxPlayers, serverSpeed } = msg;
            switch (type) {
                case "PLAYER_COUNT":
                    this.players = players;
                    this.maxPlayers = maxPlayers;
                    this.serverSpeed = serverSpeed;
                    break;
            }
        });

        this.child.on("error", (err) => {
            this._log(`[Supervisor Error]: Failed to start process: ${err.message}`);
            this._handleExit(null, "SPAWN_ERROR");
        });

        this.child.on("exit", (code, signal) => {
            this._handleExit(code, signal);
        });
    }

    _handleExit(code, signal) {
        this.child = null;

        this.state = "STOPPED";
        this._log(`[Supervisor]: Process exited (Code: ${code}, Signal: ${signal}).`);

        if (signal !== "SIGKILL" && signal !== "SIGTERM") {
            this._log(`[Supervisor]: Restarting process in 5 seconds.`)
            setTimeout(() => {
                this.restart();
            }, 5000)
        }

        this.writeStream.end();
    }

    async _killProcessTree(pid, initialSignal = "SIGTERM") {
        return new Promise((resolve) => {
            let isDead = false;

            const timer = setTimeout(() => {
                if (!isDead) {
                    this._log(`[Supervisor]: Process did not exit in ${this.killTimeoutMs}ms. Escalating to SIGKILL.`);
                    this._rawKill(pid, "SIGKILL");
                    resolve();
                }
            }, this.killTimeoutMs);

            // Listen for when it actually dies
            if (this.child) {
                this.child.once("exit", () => {
                    isDead = true;
                    clearTimeout(timer);
                    resolve();
                });
            } else {
                clearTimeout(timer);
                resolve();
            }

            // Initial graceful kill
            this._rawKill(pid, initialSignal);
        });
    }

    _rawKill(pid, signal) {
        try {
            if (process.platform === "win32") {
                // Windows requires `taskkill` to reliably wipe child trees
                spawn("taskkill", ["/pid", pid.toString(), "/T", "/F"], { stdio: "ignore" });
            } else {
                // POSIX: Target negative PID to kill the entire process group
                process.kill(-pid, signal);
            }
        } catch (e) {
            // ESRCH indicates process already exited
            if (e.code !== "ESRCH") {
                this._log(`[Supervisor Kill Error]: ${e.message}`);
            }
        }
    }

    // --- Stream Containment & UI Logging ---

    _handleOutput(type, chunk) {
        const lines = chunk.toString().split(/\r?\n/);
        for (const line of lines) {
            if (line.trim().length > 0) {
                const prefix = type === "STDOUT" ? "\x1b[36m[OUT]\x1b[0m" : "\x1b[31m[ERR]\x1b[0m";
                this._log(`${prefix} ${line}\n`);
            }
        }
    }

    _log(msg) {
        this.writeStream.write(`\x1b[33m${msg}\x1b[0m\n`);
    }

    // --- Terminal & OS Signal Interception ---

    _bindSystemSignals() {
        const exitSignals = ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"];

        exitSignals.forEach((sig) => {
            process.on(sig, async () => {
                this._log(`\n[Supervisor]: Received ${sig}. Terminating child process tree...`);
                await this.stop(sig === "SIGINT" ? "SIGINT" : "SIGTERM");
                process.exit(0);
            });
        });

        process.on("uncaughtException", async (err) => {
            this._log(`[Supervisor Fatal Exception]: ${err.stack || err.message}`);
            await this.stop("SIGKILL");
            process.exit(1);
        });

        process.on("unhandledRejection", async (reason) => {
            this._log(`[Supervisor Unhandled Rejection]: ${reason}`);
            await this.stop("SIGKILL");
            process.exit(1);
        });
    }
}

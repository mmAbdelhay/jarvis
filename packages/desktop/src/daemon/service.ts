import { buildDarwinService } from "./service-darwin.js";
import { buildLinuxService } from "./service-linux.js";
import { buildWindowsService } from "./service-win32.js";

export type ServicePlatform = "darwin" | "linux" | "win32";
export type ServiceStatus = "not-installed" | "stopped" | "running" | "unknown";

export interface ServiceFileSystem {
  writeFile(path: string, contents: string, options?: { mode?: number }): Promise<void>;
  mkdir(path: string, options: { recursive: true }): Promise<void>;
  rm(path: string, options: { force: true }): Promise<void>;
  exists(path: string): Promise<boolean>;
}

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type RunCommand = (command: string, args: readonly string[]) => Promise<CommandResult>;
export type SpawnDetached = (command: string, args: readonly string[]) => Promise<void>;
export interface ControlSocketRequired {
  ok: false;
  reason: "use-control-socket";
}

export interface ServiceManager {
  install(): Promise<void>;
  uninstall(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<undefined | ControlSocketRequired>;
  restart(): Promise<undefined | ControlSocketRequired>;
  status(): Promise<ServiceStatus>;
}

export interface CreateServiceManagerOptions {
  platform: ServicePlatform;
  home: string;
  uid: number;
  execPath: string;
  daemonScript: string;
  fs: ServiceFileSystem;
  run: RunCommand;
  spawnDetached: SpawnDetached;
}

type Command = readonly [command: string, args: readonly string[]];

export function createServiceManager(options: CreateServiceManagerOptions): ServiceManager {
  const execute = async (command: Command): Promise<CommandResult> => {
    const result = await options.run(command[0], command[1]);
    if (result.code !== 0) {
      throw new Error(`${command[0]} exited with code ${result.code}`);
    }
    return result;
  };

  if (options.platform === "darwin") {
    const service = buildDarwinService(options);
    const parentDirectory = `${options.home}/Library/LaunchAgents`;
    return {
      async install() {
        await options.fs.mkdir(parentDirectory, { recursive: true });
        await options.fs.mkdir(service.logDirectory, { recursive: true });
        await options.fs.writeFile(service.filePath, service.contents, {
          mode: service.fileMode,
        });
        const loaded = await options.run(...service.commands.status);
        if (loaded.code === 0) await options.run(...service.commands.uninstall);
        await execute(service.commands.install);
      },
      async uninstall() {
        if (await options.fs.exists(service.filePath)) {
          await options.run(...service.commands.uninstall);
        }
        await options.fs.rm(service.filePath, { force: true });
      },
      async start() {
        const loaded = await options.run(...service.commands.status);
        await execute(loaded.code === 0 ? service.commands.start : service.commands.install);
      },
      async stop() {
        await options.run(...service.commands.stop);
      },
      async restart() {
        const loaded = await options.run(...service.commands.status);
        await execute(loaded.code === 0 ? service.commands.start : service.commands.install);
      },
      async status() {
        const result = await options.run(...service.commands.status);
        if (result.code === 0) {
          return /^\s*state = running\s*$/m.test(result.stdout) ? "running" : "stopped";
        }
        return (await options.fs.exists(service.filePath)) ? "stopped" : "not-installed";
      },
    };
  }

  if (options.platform === "linux") {
    const service = buildLinuxService(options);
    const parentDirectory = `${options.home}/.config/systemd/user`;
    return {
      async install() {
        await options.fs.mkdir(parentDirectory, { recursive: true });
        await options.fs.writeFile(service.filePath, service.contents, {
          mode: service.fileMode,
        });
        await execute(service.commands.reload);
        const active = await options.run(...service.commands.status);
        if (active.code === 0) {
          await execute(service.commands.enable);
          await execute(service.commands.restart);
        } else {
          await execute(service.commands.start);
        }
      },
      async uninstall() {
        if (await options.fs.exists(service.filePath)) {
          await options.run(...service.commands.stop);
        }
        await options.fs.rm(service.filePath, { force: true });
        await execute(service.commands.reload);
      },
      async start() {
        await execute(service.commands.start);
      },
      async stop() {
        await execute(service.commands.stop);
      },
      async restart() {
        await execute(service.commands.restart);
      },
      async status() {
        if (!(await options.fs.exists(service.filePath))) return "not-installed";
        const result = await options.run(...service.commands.status);
        if (result.code === 0) return "running";
        if (result.code === 3) return "stopped";
        return "unknown";
      },
    };
  }

  const service = buildWindowsService(options);
  return {
    async install() {
      await execute(service.commands.install);
    },
    async uninstall() {
      await options.run(...service.commands.uninstall);
    },
    async start() {
      await options.spawnDetached(options.execPath, ["--jarvis-daemon"]);
    },
    async stop() {
      return { ok: false, reason: "use-control-socket" };
    },
    async restart() {
      return { ok: false, reason: "use-control-socket" };
    },
    async status() {
      const result = await options.run(...service.commands.status);
      return result.code === 0 ? "stopped" : "not-installed";
    },
  };
}

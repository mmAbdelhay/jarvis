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

export interface ServiceManager {
  install(): Promise<void>;
  uninstall(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  restart(): Promise<void>;
  status(): Promise<ServiceStatus>;
}

export interface CreateServiceManagerOptions {
  platform: ServicePlatform;
  home: string;
  uid: number;
  localAppData: string;
  execPath: string;
  daemonScript: string;
  env: Readonly<Record<string, string | undefined>>;
  fs: ServiceFileSystem;
  run: RunCommand;
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
        await execute(service.commands.install);
      },
      async uninstall() {
        if (await options.fs.exists(service.filePath)) {
          await options.run(...service.commands.uninstall);
        }
        await options.fs.rm(service.filePath, { force: true });
      },
      async start() {
        await execute(service.commands.start);
      },
      async stop() {
        await execute(service.commands.stop);
      },
      async restart() {
        await execute(service.commands.start);
      },
      async status() {
        if (!(await options.fs.exists(service.filePath))) return "not-installed";
        const result = await options.run(...service.commands.status);
        if (result.code === 0) return "running";
        if (result.code === 113) return "stopped";
        return "unknown";
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
        await execute(service.commands.start);
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
  const parentDirectory = `${options.localAppData}\\Jarvis`;
  return {
    async install() {
      await options.fs.mkdir(parentDirectory, { recursive: true });
      await options.fs.writeFile(service.filePath, service.contents);
      await execute(service.commands.install);
    },
    async uninstall() {
      if (await options.fs.exists(service.filePath)) {
        await options.run(...service.commands.uninstall);
      }
      await options.fs.rm(service.filePath, { force: true });
    },
    async start() {
      await execute(service.commands.start);
    },
    async stop() {
      await execute(service.commands.stop);
    },
    async restart() {
      await execute(service.commands.stop);
      await execute(service.commands.start);
    },
    async status() {
      if (!(await options.fs.exists(service.filePath))) return "not-installed";
      const result = await options.run(...service.commands.status);
      if (result.code !== 0) return "unknown";
      return /\brunning\b/i.test(result.stdout) ? "running" : "stopped";
    },
  };
}

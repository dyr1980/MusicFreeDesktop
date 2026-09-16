import { app, ipcMain } from "electron";
import fs from "fs/promises";
import path from "path";
import { Plugin } from "./plugin";
import { rimraf } from "rimraf";
import _axios from "axios";
import https from "https";
import voidCallback from "@/common/void-callback";
import { localPluginHash, localPluginName } from "@/common/constant";
import localPlugin from "./internal-plugins/local-plugin";
import { addRandomHash } from "@/common/normalize-util";
import { IWindowManager } from "@/types/main/window-manager";
import AppConfig from "@shared/app-config/main";
import { compare } from "compare-versions";
import { nanoid } from "nanoid";
import logger from "@shared/logger/main";

const axios = _axios.create({
    httpsAgent: new https.Agent({
        rejectUnauthorized: false,
    }),
});

interface ICallPluginMethodParams<
    T extends keyof IPlugin.IPluginInstanceMethods,
> {
    hash: string;
    platform: string;
    method: T;
    args: Parameters<IPlugin.IPluginInstanceMethods[T]>;
}


class PluginManager {
    private clonedPlugins: IPlugin.IPluginDelegate[] = [];

    private inited = false;

    private _plugins: Plugin[] = [];
    public get plugins() {
        return this._plugins;
    }

    public set plugins(newPlugins: Plugin[]) {
        this._plugins = newPlugins;
        this.clonedPlugins = newPlugins.map((p) => {
            const sPlugin: IPlugin.IPluginDelegate = {} as any;
            sPlugin.supportedMethod = [];
            for (const k in p.instance) {
                // @ts-ignore
                if (typeof p.instance[k] === "function") {
                    sPlugin.supportedMethod.push(k);
                } else {
                    // @ts-ignore
                    sPlugin[k] = p.instance[k];
                }
            }
            sPlugin.hash = p.hash;
            sPlugin.path = p.path;
            return JSON.parse(JSON.stringify(sPlugin));
        });
    }

    private windowManager: IWindowManager;

    // 插件存储路径
    private _pluginBasePath: string;

    private get pluginBasePath() {
        if (this._pluginBasePath) {
            return this._pluginBasePath;
        }
        this._pluginBasePath = path.resolve(
            app.getPath("userData"),
            "./musicfree-plugins",
        );
        return this._pluginBasePath;
    }

    public async setup(windowManager: IWindowManager) {
        this.windowManager = windowManager;
        // 1. setup events
        ipcMain.handle("@shared/plugin-manager/call-plugin-method", (_evt, data) => {
            return this.callPluginMethod(data);
        });

        ipcMain.handle("@shared/plugin-manager/get-all-plugins", () => this.clonedPlugins);

        ipcMain.handle("@shared/plugin-manager/load-all-plugins", async () => {
            if (!this.inited) {
                await this.loadAllPlugins();
            } else {
                this.syncPlugins();
            }
            return this.clonedPlugins;
        });

        ipcMain.handle("@shared/plugin-manager/uninstall-plugin", async (_, hash) => {
            await this.uninstallPlugin(hash);
            this.syncPlugins();
        });

        ipcMain.on("@shared/plugin-manager/update-all-plugins", this.updateAllPlugins);

        ipcMain.handle("@shared/plugin-manager/install-plugin-remote", async (_, urlLike) => {
            return await this.installPluginFromRemoteUrl(urlLike);
        });

        ipcMain.handle("@shared/plugin-manager/install-plugin-local", async (_, urlLike) => {
            return await this.installPluginFromLocalFile(urlLike);
        });

        // 新增：同步订阅接口
        ipcMain.handle("@shared/plugin-manager/sync-subscription", async (_, urls: string[]) => {
            await this.syncSubscription(urls);
        });

        // 2. check if folder exists
        let folderExists = true;
        try {
            const res = await fs.stat(this.pluginBasePath);
            if (!res.isDirectory()) {
                await rimraf(this.pluginBasePath);
                folderExists = false;
            }
        } catch {
            folderExists = false;
        }
        if (!folderExists) {
            await fs.mkdir(this.pluginBasePath, {
                recursive: true,
            }).catch(voidCallback);
        }

        // 3. load all plugins
        await this.loadAllPlugins();
        this.inited = true;
    }

    // 调用某个插件的方法
    private callPluginMethod({
        hash,
        platform,
        method,
        args,
    }: ICallPluginMethodParams<keyof IPlugin.IPluginInstanceMethods>,
    ) {
        let plugin: Plugin;
        if (hash === localPluginHash || platform === localPluginName) {
            plugin = localPlugin;
        } else if (hash) {
            plugin = this.plugins.find((item) => item.hash === hash);
        } else if (platform) {
            plugin = this.plugins.find((item) => item.name === platform);
        }
        if (!plugin) {
            return null;
        }
        return plugin.methods[method]?.apply?.({ plugin }, args);
    }

    private syncPlugins() {
        const mainWindow = this.windowManager.mainWindow;
        if (mainWindow) {
            mainWindow.webContents.send("@/shared/plugin-manager/sync-plugins", this.clonedPlugins);
        }
    }


    /********************** 安装插件 *******************/
    // 修改：增加 srcUrl 和 forceUpdate 参数
    private async installPluginFromRawCodeImpl(funcCode: string, srcUrl?: string, forceUpdate = false) {
        const plugins = this.plugins;
        const plugin = new Plugin(funcCode, "");
        
        // 记录插件来源，用于后续同步比对
        if (srcUrl) {
            plugin.instance.srcUrl = srcUrl;
        }

        const pluginIndex = plugins.findIndex((p) => p.hash === plugin.hash);
        
        // 如果不是强制更新，且已经存在相同 Hash 的插件，则跳过
        if (!forceUpdate && pluginIndex !== -1) {
            return;
        }
        
        const oldVersionPlugin = plugins.find((p) => p.name === plugin.name);
        
        // 如果不是强制更新，且存在旧版本，则进行版本比对
        if (
            !forceUpdate &&
            oldVersionPlugin &&
            !AppConfig.getConfig("plugin.notCheckPluginVersion")
        ) {
            if (
                compare(
                    oldVersionPlugin.instance.version ?? "",
                    plugin.instance.version ?? "",
                    ">",
                )
            ) {
                throw new Error("已安装更新版本的插件");
            }
        }

        if (plugin.hash !== "") {
            const fn = nanoid();
            const _pluginPath = path.resolve(this.pluginBasePath, `${fn}.js`);
            await fs.writeFile(_pluginPath, funcCode, "utf8");
            plugin.path = _pluginPath;
            
            // 删除旧版本文件
            if (oldVersionPlugin) {
                try {
                    await rimraf(oldVersionPlugin.path);
                } catch {
                    // pass
                }
            }
            
            // 组装新插件列表
            let newPlugins = plugins.filter((_) => _.hash !== oldVersionPlugin?.hash);
            newPlugins.push(plugin);
            
            this.plugins = newPlugins;
            return;
        }
        throw new Error("插件无法解析!");
    }

    // 修改：传递 srcUrl 和 forceUpdate
    private async installPluginFromUrlImpl(urlLike: string, forceUpdate = false) {
        const funcCode = (await axios.get(urlLike)).data;
        if (funcCode) {
            await this.installPluginFromRawCodeImpl(funcCode, urlLike, forceUpdate);
        }
    }

    // 加载所有插件
    public async loadAllPlugins() {
        const rawPluginNames = await fs.readdir(this.pluginBasePath);
        const pluginHashSet = new Set<string>();
        const plugins: Plugin[] = [];
        for (let i = 0; i < rawPluginNames.length; ++i) {
            try {
                const pluginPath = path.resolve(this.pluginBasePath, rawPluginNames[i]);
                const fileStat = await fs.stat(pluginPath);
                if (fileStat.isFile() && path.extname(pluginPath) === ".js") {
                    const funcCode = await fs.readFile(pluginPath, "utf-8");
                    const plugin = new Plugin(funcCode, pluginPath);
                    if (pluginHashSet.has(plugin.hash)) {
                        continue;
                    }
                    if (plugin.hash !== "") {
                        pluginHashSet.add(plugin.hash);
                        plugins.push(plugin);
                    }
                }
            } catch (e) {
                logger.logError("插件加载失败", e);
            }
        }
        this.plugins = plugins;
        this.syncPlugins();
    }

    // 从本地文件安装插件
    public async installPluginFromLocalFile(urlLike: string) {
        try {
            const url = urlLike.trim();
            if (url.endsWith(".js")) {
                const rawCode = await fs.readFile(url, "utf8");
                await this.installPluginFromRawCodeImpl(rawCode);
            } else if (url.endsWith(".json")) {
                const jsonFile = JSON.parse(await fs.readFile(url, "utf8"));

                for (const cfg of jsonFile?.plugins ?? []) {
                    await this.installPluginFromUrlImpl(addRandomHash(cfg.url));
                }
            }
        } finally {
            this.syncPlugins();
        }
    }

    // 从远程url安装插件
    public async installPluginFromRemoteUrl(urlLike: string, forceUpdate = false) {
        try {
            const url = urlLike.trim();
            if (url.endsWith(".js")) {
                await this.installPluginFromUrlImpl(addRandomHash(url), forceUpdate);
            } else if (url.endsWith(".json")) {
                const jsonFile = (await axios.get(addRandomHash(url))).data;

                for (const cfg of jsonFile?.plugins ?? []) {
                    await this.installPluginFromUrlImpl(addRandomHash(cfg.url), forceUpdate);
                }
            }
        } finally {
            this.syncPlugins();
        }
    }

    // 新增：同步订阅源（全量覆盖更新 + 智能清理）
    public async syncSubscription(subscriptionUrls: string[]) {
        try {
            const expectedPluginUrls = new Set<string>(); // 记录在线接口里实际需要的所有插件地址
            
            // 1. 解析所有在线接口，收集预期需要的插件下载地址
            for (const subUrl of subscriptionUrls) {
                const url = subUrl.trim();
                if (url.endsWith(".json")) {
                    try {
                        const jsonFile = (await axios.get(addRandomHash(url))).data;
                        for (const cfg of jsonFile?.plugins ?? []) {
                            if (cfg.url) {
                                expectedPluginUrls.add(cfg.url);
                            }
                        }
                    } catch (e) {
                        logger.logError(`解析订阅源失败: ${url}`, e);
                        throw new Error(`无法获取在线订阅内容，请检查网络或订阅源是否失效。`);
                    }
                } else if (url.endsWith(".js")) {
                    expectedPluginUrls.add(url);
                }
            }

            // 【安全加固】如果在线接口解析出来一个插件都没有，说明接口异常，拒绝执行删除操作
            if (expectedPluginUrls.size === 0) {
                throw new Error("在线订阅源未返回任何有效插件，为防止误删本地插件，已终止操作。");
            }

            // 2. 删除本地存在，但在线接口里已经删除了的插件
            const pluginsToRemove = this.plugins.filter((p) => {
                const localSrcUrl = p.instance?.srcUrl; 
                // 如果本地插件没有 srcUrl（例如手动安装的），则不删除它（给予保护）
                if (!localSrcUrl) return false; 
                return !expectedPluginUrls.has(localSrcUrl);
            });

            for (const p of pluginsToRemove) {
                logger.logInfo(`在线接口已删除插件，正在卸载: ${p.name}`);
                await this.uninstallPlugin(p.hash);
            }

            // 3. 重新下载并强制覆盖所有在线接口中的插件
            for (const subUrl of subscriptionUrls) {
                const url = subUrl.trim();
                // 强制更新传入 true
                await this.installPluginFromRemoteUrl(url, true);
            }
        } finally {
            this.syncPlugins(); // 完成后同步给前端刷新界面
        }
    }

    // 更新所有插件
    public async updateAllPlugins() {
        return Promise.allSettled(
            this.plugins.map((plg) =>
                plg.instance.srcUrl ? this.installPluginFromRemoteUrl(plg.instance.srcUrl) : null,
            ),
        );
    }

    // 卸载插件
    public async uninstallPlugin(hash: string) {
        const targetIndex = this.plugins.findIndex((_) => _.hash === hash);
        if (targetIndex !== -1) {
            try {
                await rimraf(this.plugins[targetIndex].path);
                this.plugins = this.plugins.filter((_) => _.hash !== hash);
            } catch {
                // pass
            }
        }
    }
}


export default new PluginManager();

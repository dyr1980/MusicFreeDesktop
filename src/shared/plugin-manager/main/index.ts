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

type SyncResult = {
    success: boolean;
    msg: string;
    errors: string[];
    successUrls: string[];
    failUrls: string[];
};

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
    private isSyncingSubscription = false;
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
        // 新增IPC
        ipcMain.handle("@shared/plugin-manager/sync-subscription", async (_, urls: string[]) => {
            return await this.syncSubscription(urls);
        });
        ipcMain.handle("@shared/plugin-manager/retryFailedSubscription", async (_, urls: string[]) => {
            return await this.retryFailedSubscription(urls);
        });
        ipcMain.handle("@shared/plugin-manager/finishSyncProcess", async () => {
            return await this.finishSyncProcess();
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
                    const funcCode = await fs.readFile(pluginPath, "utf8");
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

    // 第一轮完整同步订阅源，单个失败不中断，仅第一轮执行插件清理
    public async syncSubscription(subscriptionUrls: string[]): Promise<SyncResult> {
        if (this.isSyncingSubscription) {
            return {
                success: false,
                msg: "订阅同步任务正在运行，请等待完成后再次点击",
                errors: [],
                successUrls: [],
                failUrls: [],
            };
        }
        this.isSyncingSubscription = true;
        const result: SyncResult = {
            success: true,
            msg: "订阅同步第一轮完成",
            errors: [],
            successUrls: [],
            failUrls: [],
        };
        const expectedPluginUrls = new Set<string>();

        try {
            // 第一层：解析全部订阅源，单个失败不中断
            for (const subUrl of subscriptionUrls) {
                const url = subUrl.trim();
                if (!url) continue;
                try {
                    if (url.endsWith(".json")) {
                        const jsonFile = (await axios.get(addRandomHash(url))).data;
                        for (const cfg of jsonFile?.plugins ?? []) {
                            if (cfg.url) {
                                expectedPluginUrls.add(cfg.url);
                            }
                        }
                    } else if (url.endsWith(".js")) {
                        expectedPluginUrls.add(url);
                    }
                    result.successUrls.push(url);
                } catch (e) {
                    const errMsg = `解析订阅源【${url}】失败：${(e as Error).message}`;
                    logger.logError(errMsg, e);
                    result.errors.push(errMsg);
                    result.failUrls.push(url);
                }
            }

            // 保护机制：全部解析完没有任何插件链接，不删除插件，直接退出
            if (expectedPluginUrls.size === 0) {
                throw new Error("所有订阅源解析完毕，但未获取任何有效插件地址，为保护本地插件，终止同步");
            }

            // 删除在线订阅已经不存在的旧插件（仅第一轮执行）
            const pluginsToRemove = this.plugins.filter((p) => {
                const localSrcUrl = p.instance?.srcUrl;
                // 如果本地插件没有 srcUrl（例如手动安装的），则不删除它（给予保护）
                if (!localSrcUrl) return false;
                return !expectedPluginUrls.has(localSrcUrl);
            });
            for (const p of pluginsToRemove) {
                logger.logInfo(`在线订阅已移除，卸载插件: ${p.name}`);
                await this.uninstallPlugin(p.hash);
            }

            // 第二层：逐个安装订阅源插件
            for (const subUrl of subscriptionUrls) {
                const url = subUrl.trim();
                if (!url) continue;
                // 如果解析阶段已经失败，跳过安装
                if (result.failUrls.includes(url)) continue;
                try {
                    await this.installPluginFromRemoteUrl(url, true);
                } catch (e) {
                    const errMsg = `更新订阅源【${url}】插件失败：${(e as Error).message}`;
                    logger.logError(errMsg, e);
                    result.errors.push(errMsg);
                    result.successUrls = result.successUrls.filter(item => item !== url);
                    result.failUrls.push(url);
                }
            }

            if (result.failUrls.length > 0) {
                result.msg = `订阅同步第一轮完成，共${subscriptionUrls.length}个订阅源，成功${result.successUrls.length}个，失败${result.failUrls.length}个`;
            } else {
                result.msg = `订阅同步第一轮完成，共${subscriptionUrls.length}个订阅源，全部成功`;
            }
        } catch (globalErr) {
            result.success = false;
            result.msg = `订阅同步终止：${(globalErr as Error).message}`;
            logger.logError("订阅同步全局异常", globalErr);
        } finally {
            this.syncPlugins();
            // ❗不释放锁，锁交给前端调用 finishSyncProcess 释放
        }
        return result;
    }

    // 重试失败订阅源：只解析+安装，**不执行插件卸载**
    public async retryFailedSubscription(subscriptionUrls: string[]): Promise<SyncResult> {
        const result: SyncResult = {
            success: true,
            msg: "重试完成",
            errors: [],
            successUrls: [],
            failUrls: [],
        };

        try {
            for (const subUrl of subscriptionUrls) {
                const url = subUrl.trim();
                if (!url) continue;
                try {
                    if (url.endsWith(".json")) {
                        const jsonFile = (await axios.get(addRandomHash(url))).data;
                        // 重试阶段不再维护 expectedPluginUrls、不删插件
                    } else if (url.endsWith(".js")) {
                        // js源无需解析插件列表
                    }
                    await this.installPluginFromRemoteUrl(url, true);
                    result.successUrls.push(url);
                } catch (e) {
                    const errMsg = `重试订阅源【${url}】失败：${(e as Error).message}`;
                    logger.logError(errMsg, e);
                    result.errors.push(errMsg);
                    result.failUrls.push(url);
                }
            }
            if (result.failUrls.length > 0) {
                result.msg = `本轮重试完成，共${subscriptionUrls.length}个订阅源，成功${result.successUrls.length}个，失败${result.failUrls.length}个`;
            } else {
                result.msg = `本轮重试完成，共${subscriptionUrls.length}个订阅源，全部成功`;
            }
        } catch (globalErr) {
            result.success = false;
            result.msg = `重试异常：${(globalErr as Error).message}`;
            logger.logError("重试订阅源全局异常", globalErr);
        } finally {
            this.syncPlugins();
            // ❗不释放锁
        }
        return result;
    }

    public async finishSyncProcess() {
        this.isSyncingSubscription = false;
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

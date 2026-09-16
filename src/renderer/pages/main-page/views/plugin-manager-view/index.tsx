import { useState } from "react";
import { hideModal, showModal } from "@/renderer/components/Modal";
import PluginTable from "./components/plugin-table";
import "./index.scss";
import { getUserPreference } from "@/renderer/utils/user-perference";
import { toast } from "react-toastify";
import A from "@/renderer/components/A";
import { Trans, useTranslation } from "react-i18next";
import { dialogUtil } from "@shared/utils/renderer";
import PluginManager from "@shared/plugin-manager/renderer";

export default function PluginManagerView() {
    const { t } = useTranslation();
    // 控制全局加载遮罩的状态
    const [isUpdating, setIsUpdating] = useState(false);

    return (
        <div
            id="page-container"
            className="page-container plugin-manager-view-container"
        >
            {/* 全局 Loading 遮罩层，复刻原作者居中弹窗体验 */}
            {isUpdating && (
                <>
                    {/* 内联注入 CSS 动画，避免修改 scss 文件 */}
                    <style>{`
                        @keyframes stretch {
                            0% { transform: scaleY(1); }
                            50% { transform: scaleY(1.5); }
                            100% { transform: scaleY(1); }
                        }
                    `}</style>
                    <div
                        style={{
                            position: "fixed",
                            top: 0, left: 0, right: 0, bottom: 0,
                            backgroundColor: "rgba(0, 0, 0, 0.4)", // 背景变暗
                            display: "flex",
                            justifyContent: "center",
                            alignItems: "center",
                            zIndex: 9999,
                            flexDirection: "column",
                        }}
                    >
                        <div
                            style={{
                                backgroundColor: "var(--background-color, #fff)", // 适配主题色
                                padding: "30px 50px",
                                borderRadius: "12px",
                                boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
                                display: "flex",
                                flexDirection: "column",
                                alignItems: "center",
                                gap: "16px",
                                color: "var(--text-color, #333)"
                            }}
                        >
                            {/* 三个竖条的加载动画 */}
                            <div style={{ display: "flex", gap: "6px", height: "30px", alignItems: "center" }}>
                                <div style={{ width: "8px", height: "20px", backgroundColor: "#f2711c", borderRadius: "4px", animation: "stretch 1s ease-in-out infinite" }} />
                                <div style={{ width: "8px", height: "30px", backgroundColor: "#f2711c", borderRadius: "4px", animation: "stretch 1s ease-in-out infinite 0.2s" }} />
                                <div style={{ width: "8px", height: "20px", backgroundColor: "#f2711c", borderRadius: "4px", animation: "stretch 1s ease-in-out infinite 0.4s" }} />
                            </div>
                            <div style={{ fontSize: "16px", fontWeight: "bold" }}>正在更新订阅中...</div>
                            <div style={{ fontSize: "12px", color: "#888" }}>请稍候，正在同步在线接口的插件</div>
                        </div>
                    </div>
                </>
            )}

            <div className="header">
                {t("plugin_management_page.plugin_management")}
            </div>
            <div className="operation-area">
                <div className="left-part">
                    <div
                        role="button"
                        data-type="normalButton"
                        onClick={async () => {
                            try {
                                const result = await dialogUtil.showOpenDialog({
                                    title: t("plugin_management_page.choose_plugin"),
                                    buttonLabel: t("plugin_management_page.install"),
                                    filters: [
                                        {
                                            extensions: ["js", "json"],
                                            name: t("plugin_management_page.musicfree_plugin"),
                                        },
                                    ],
                                });
                                if (result.canceled) {
                                    return;
                                }
                                await PluginManager.installPluginFromLocal(result.filePaths[0]);
                                toast.success(t("plugin_management_page.install_successfully"));
                            } catch (e) {
                                toast.warn(
                                    `${t("plugin_management_page.install_failed")}: ${
                                        e.message ?? t("plugin_management_page.invalid_plugin")
                                    }`,
                                );
                            }
                        }}
                    >
                        {t("plugin_management_page.install_from_local_file")}
                    </div>
                    <div
                        role="button"
                        data-type="normalButton"
                        onClick={() => {
                            showModal("SimpleInputWithState", {
                                title: t("plugin_management_page.install_plugin_from_network"),
                                placeholder: t(
                                    "plugin_management_page.error_hint_plugin_should_end_with_js_or_json",
                                ),
                                okText: t("plugin_management_page.install"),
                                loadingText: t("plugin_management_page.installing"),
                                withLoading: true,
                                async onOk(text) {
                                    if (
                                        text.trim().endsWith(".json") ||
                    text.trim().endsWith(".js")
                                    ) {
                                        return PluginManager.installPluginFromRemote(text);
                                    } else {
                                        throw new Error(
                                            t(
                                                "plugin_management_page.error_hint_plugin_should_end_with_js_or_json",
                                            ),
                                        );
                                    }
                                },
                                onPromiseResolved() {
                                    toast.success(
                                        t("plugin_management_page.install_successfully"),
                                    );
                                    hideModal();
                                },
                                onPromiseRejected(e) {
                                    toast.warn(
                                        `${t("plugin_management_page.install_failed")}: ${
                                            e.message ?? t("plugin_management_page.invalid_plugin")
                                        }`,
                                    );
                                },
                                hints: [
                                    <Trans
                                        i18nKey={"plugin_management_page.info_hint_install_plugin"}
                                        components={{
                                            a: <A href="https://musicfree.catcat.work"></A>,
                                        }}
                                    ></Trans>,
                                ],
                            });
                        }}
                    >
                        {t("plugin_management_page.install_plugin_from_network")}
                    </div>
                </div>
                <div className="right-part">
                    <div
                        role="button"
                        data-type="normalButton"
                        onClick={() => {
                            showModal("PluginSubscription");
                        }}
                    >
                        {t("plugin_management_page.subscription_setting")}
                    </div>
                    {/* 修改后的更新订阅按钮 */}
                    <div
                        role="button"
                        data-type="normalButton"
                        style={{
                            opacity: isUpdating ? 0.5 : 1,
                            pointerEvents: isUpdating ? "none" : "auto",
                        }}
                        onClick={async () => {
                            if (isUpdating) return; // 双重保险，防止重复点击

                            const subscription = getUserPreference("subscription");

                            if (subscription?.length) {
                                // 弹出提示，防止用户误触，并告知用户变量会丢失
                                const confirm = window.confirm(
                                    "⚠️ 提示：同步订阅将强制拉取最新的在线插件，并清理在线接口中已删除的插件。\n如果本地插件有配置过用户变量，可能会丢失，确定继续吗？"
                                );
                                if (!confirm) return;

                                // 收集所有订阅源的地址
                                const urls = subscription.map((item) => item.srcUrl);

                                // 开启全局加载遮罩
                                setIsUpdating(true);

                                try {
                                    // 调用新加的同步方法
                                    await PluginManager.syncSubscription(urls);
                                    toast.success(t("plugin_management_page.update_successfully"));
                                } catch (e) {
                                    toast.error(`更新失败: ${e.message}`);
                                } finally {
                                    // 无论成功失败，关闭全局加载遮罩
                                    setIsUpdating(false);
                                }
                            } else {
                                toast.warn(t("plugin_management_page.no_subscription"));
                            }
                        }}
                    >
                        {t("plugin_management_page.update_subscription")}
                    </div>
                </div>
            </div>
            <PluginTable></PluginTable>
        </div>
    );
}

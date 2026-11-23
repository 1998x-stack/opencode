import { Button } from "@opencode/ui/button"
import { Icon } from "@opencode/ui/icon"
import { Tabs } from "@opencode/ui/tabs"
import { uuid } from "@opencode/util/uuid"
import { createEffect, createMemo, For, onCleanup, Show, type Component } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/runtime/i18n/language"
import { useServerSDK } from "@/runtime/server/client"
import { useData } from "@/runtime/server/current"
import { formatServerError } from "@/runtime/server/errors"
import { showToast } from "@/shell/notifications/toast"
import { SkillStoreRPC, type AssetDetail, type AssetSummary, type Installation, type Operation } from "./skill-store-rpc"

type View = "discover" | "installed"

export const SettingsSkillStore: Component<{ directory?: string; onRuntimeRefresh: () => void }> = (props) => {
  const language = useLanguage()
  const serverSdk = useServerSDK()
  const data = useData()
  const rpc = () => serverSdk.api.rpc(SkillStoreRPC)
  const locationDirectory = createMemo(() => props.directory ?? data.location.default().directory)
  const [state, setState] = createStore({
    view: "discover" as View, query: "", loading: false, configured: true, error: "",
    items: [] as AssetSummary[], installations: [] as Installation[], operations: [] as Operation[],
    updates: [] as Array<{ installationId: string; assetId: string; currentVersion: string; latestVersion: string }>,
    detail: undefined as AssetDetail | undefined, busy: [] as string[],
  })
  const busy = (id: string) => state.busy.includes(id)
  const setBusy = (id: string, value: boolean) => setState("busy", (items) => value ? [...new Set([...items, id])] : items.filter((item) => item !== id))
  const refreshInstalled = async () => {
    const [installed, operations] = await Promise.all([rpc().installationList({}), rpc().operationList({})])
    setState("installations", installed.items)
    setState("operations", operations.items)
  }
  const search = async () => {
    setState("loading", true)
    setState("error", "")
    try {
      const result = await rpc().catalogSearch({ query: state.query, limit: 24 })
      setState("configured", result.configured)
      setState("items", result.items)
    } catch (error) {
      setState("error", formatServerError(error, language.t))
    } finally {
      setState("loading", false)
    }
  }
  const install = async (asset: AssetSummary, version?: string) => {
    setBusy(asset.assetId, true)
    try {
      await rpc().installStart({ assetId: asset.assetId, version, idempotencyKey: uuid() })
      await refreshInstalled()
      setState("view", "installed")
    } catch (error) {
      showToast({ title: language.t("common.requestFailed"), description: formatServerError(error, language.t) })
    } finally { setBusy(asset.assetId, false) }
  }
  const installUpdate = async (item: Installation, version: string) => {
    setBusy(item.installationId, true)
    try {
      await rpc().installStart({ assetId: item.assetId, version, idempotencyKey: uuid() })
      await refreshInstalled()
    } catch (error) {
      showToast({ title: language.t("common.requestFailed"), description: formatServerError(error, language.t) })
    } finally { setBusy(item.installationId, false) }
  }
  const toggle = async (item: Installation) => {
    setBusy(item.installationId, true)
    try {
      await rpc().installationSetEnabled({ installationId: item.installationId, enabled: !item.enabled })
      await refreshInstalled()
      props.onRuntimeRefresh()
    } catch (error) {
      showToast({ title: language.t("common.requestFailed"), description: formatServerError(error, language.t) })
    } finally { setBusy(item.installationId, false) }
  }
  const remove = async (item: Installation) => {
    setBusy(item.installationId, true)
    try {
      await rpc().installationUninstall({ installationId: item.installationId })
      await refreshInstalled()
      props.onRuntimeRefresh()
    } catch (error) {
      showToast({ title: language.t("common.requestFailed"), description: formatServerError(error, language.t) })
    } finally { setBusy(item.installationId, false) }
  }
  const cancelOperation = async (operationId: string) => {
    try { await rpc().operationCancel({ operationId }); await refreshInstalled() }
    catch (error) { showToast({ title: language.t("common.requestFailed"), description: formatServerError(error, language.t) }) }
  }
  const checkUpdates = async () => {
    try {
      const result = await rpc().updateCheck({})
      setState("updates", result.updates)
      showToast({ title: language.t("skillStore.updateCheck"), description: language.t("skillStore.updatesFound", { count: result.updates.length }) })
    } catch (error) {
      showToast({ title: language.t("common.requestFailed"), description: formatServerError(error, language.t) })
    }
  }
  const detail = async (asset: AssetSummary) => {
    try { setState("detail", await rpc().catalogDetail({ assetId: asset.assetId })) }
    catch (error) { showToast({ title: language.t("common.requestFailed"), description: formatServerError(error, language.t) }) }
  }

  createEffect(() => {
    if (serverSdk.connection.status() !== "connected") return
    const client = rpc()
    void refreshInstalled().catch((error) => setState("error", formatServerError(error, language.t)))
    const stopProgress = client.events.on("operationProgress", (event) => {
      if (event.location.directory !== locationDirectory()) return
      setState("operations", (items) => {
        const index = items.findIndex((item) => item.operationId === event.data.operationId)
        return index === -1 ? [...items, event.data] : items.map((item) => item.operationId === event.data.operationId ? event.data : item)
      })
      if (["installed", "failed", "cancelled", "interrupted"].includes(event.data.state)) {
        void refreshInstalled()
        if (event.data.state === "installed") props.onRuntimeRefresh()
      }
    })
    const stopInstalled = client.events.on("installationChanged", (event) => {
      if (event.location.directory !== locationDirectory()) return
      void refreshInstalled()
      props.onRuntimeRefresh()
    })
    onCleanup(() => { stopProgress(); stopInstalled() })
  })
  createEffect(() => {
    if (state.view === "discover" && serverSdk.connection.status() === "connected") void search()
  })

  return (
    <div class="mt-6 border-t border-border-base pt-5" data-testid="skill-store">
      <div class="flex items-center justify-between gap-3">
        <div class="min-w-0">
          <h3 class="text-14-medium">{language.t("skillStore.title")}</h3>
          <p class="mt-1 text-11-regular text-v2-text-text-muted">{language.t("skillStore.description")}</p>
        </div>
        <Show when={state.view === "installed"}>
          <Button size="small" variant="ghost-muted" onClick={checkUpdates}><Icon name="refresh-cw" />{language.t("skillStore.checkUpdates")}</Button>
        </Show>
      </div>
      <Tabs variant="pill" class="mt-4" value={state.view} onChange={(value) => { if (value === "discover" || value === "installed") setState("view", value) }}>
        <Tabs.List>
          <Tabs.Trigger value="discover">{language.t("skillStore.discover")}</Tabs.Trigger>
          <Tabs.Trigger value="installed">{language.t("skillStore.installed")}</Tabs.Trigger>
        </Tabs.List>
        <Tabs.Content value="discover">
          <div class="mt-4 flex gap-2">
            <input class="min-w-0 flex-1 rounded-md border border-border-base bg-background-base px-3 py-2 text-13-regular"
              type="search" aria-label={language.t("skillStore.search")} placeholder={language.t("skillStore.searchPlaceholder")}
              value={state.query} onInput={(event) => setState("query", event.currentTarget.value)}
              onKeyDown={(event) => { if (event.key === "Enter") void search() }} />
            <Button size="small" variant="outline" disabled={state.loading} onClick={search}><Icon name="search" />{language.t("skillStore.search")}</Button>
          </div>
          <Show when={state.error}><p role="alert" class="mt-3 text-12-regular text-text-danger">{state.error}</p></Show>
          <Show when={!state.configured}><p class="mt-3 text-12-regular text-v2-text-text-muted">{language.t("skillStore.notConfigured")}</p></Show>
          <Show when={state.loading}><p class="mt-3 text-12-regular text-v2-text-text-muted">{language.t("common.loading")}</p></Show>
          <Show when={!state.loading && state.configured && state.items.length === 0}><p class="mt-3 text-12-regular text-v2-text-text-muted">{language.t("skillStore.noResults")}</p></Show>
          <div class="mt-3 grid gap-2">
            <For each={state.items}>{(item) => (
              <div class="rounded-lg border border-border-base p-3">
                <div class="flex items-start justify-between gap-3">
                  <div class="min-w-0">
                    <div class="flex items-center gap-2"><Icon name="post-skill" class="shrink-0 text-v2-icon-icon-muted" /><span class="text-13-medium">{item.title}</span><Show when={item.latestVersion}><span class="text-11-regular text-v2-text-text-muted">{item.latestVersion}</span></Show></div>
                    <p class="mt-2 text-12-regular text-v2-text-text-muted">{item.description}</p>
                    <Show when={item.tags.length > 0}><p class="mt-2 text-11-regular text-v2-text-text-muted">{item.tags.join(" · ")}</p></Show>
                  </div>
                  <div class="flex shrink-0 gap-1">
                    <Button size="small" variant="ghost-muted" onClick={() => detail(item)}>{language.t("skillStore.details")}</Button>
                    <Button size="small" variant="outline" disabled={busy(item.assetId)} onClick={() => install(item)}>{language.t(busy(item.assetId) ? "skillStore.installing" : "skillStore.install")}</Button>
                  </div>
                </div>
                <Show when={state.detail?.asset.assetId === item.assetId}>
                  <div class="mt-3 border-t border-border-base pt-3">
                    <For each={state.detail?.versions ?? []}>{(version) => (
                      <div class="flex items-center justify-between py-1 text-12-regular">
                        <span>{version.version}</span>
                        <Button size="small" variant="ghost-muted" onClick={() => install(item, version.version)}>{language.t("skillStore.installVersion")}</Button>
                      </div>
                    )}</For>
                  </div>
                </Show>
              </div>
            )}</For>
          </div>
        </Tabs.Content>
        <Tabs.Content value="installed">
          <div class="mt-4 flex flex-col gap-2">
            <Show when={state.installations.length === 0}><p class="text-12-regular text-v2-text-text-muted">{language.t("skillStore.noInstalled")}</p></Show>
            <For each={state.installations}>{(item) => {
              const available = () => state.updates.find((update) => update.installationId === item.installationId)
              return (
                <div class="flex items-center justify-between gap-3 rounded-lg border border-border-base p-3">
                  <div class="min-w-0">
                    <div class="text-13-medium">{item.title}</div>
                    <div class="mt-1 text-11-regular text-v2-text-text-muted">{language.t("skillStore.version", { version: item.version })} · {item.runtimeSkillId}</div>
                    <Show when={available()}>{(updateInfo) => <div class="mt-1 text-11-regular text-v2-text-text-muted">{language.t("skillStore.updateAvailable", { version: updateInfo().latestVersion })}</div>}</Show>
                    <Show when={item.status !== "installed"}><div class="mt-1 text-11-regular text-text-danger">{item.status}</div></Show>
                  </div>
                  <div class="flex shrink-0 gap-1">
                    <Show when={available()}>{(updateInfo) => <Button size="small" variant="outline" disabled={busy(item.installationId)} onClick={() => installUpdate(item, updateInfo().latestVersion)}>{language.t("skillStore.update")}</Button>}</Show>
                    <Button size="small" variant="ghost-muted" disabled={busy(item.installationId)} onClick={() => toggle(item)}>{language.t(item.enabled ? "skillStore.disable" : "skillStore.enable")}</Button>
                    <Button size="small" variant="ghost-muted" disabled={busy(item.installationId)} onClick={() => remove(item)}><Icon name="trash-2" />{language.t("skillStore.remove")}</Button>
                  </div>
                </div>
              )
            }}</For>
          </div>
          <Show when={state.operations.some((item) => item.state === "queued" || item.state === "running")}>
            <div class="mt-4 border-t border-border-base pt-3">
              <div class="text-12-medium">{language.t("skillStore.operations")}</div>
              <For each={state.operations.filter((item) => item.state === "queued" || item.state === "running")}>{(operation) => (
                <div class="mt-2 rounded-md bg-background-base p-2 text-12-regular">
                  <div class="flex justify-between gap-3"><span>{operation.title} · {operation.stage}</span><span>{operation.progress}%</span></div>
                  <div class="mt-1 text-11-regular text-v2-text-text-muted">{operation.message}</div>
                  <div class="mt-2 h-1 overflow-hidden rounded bg-border-base"><div class="h-full bg-icon-strong" style={{ width: operation.progress + "%" }} /></div>
                  <Button size="small" variant="ghost-muted" onClick={() => void cancelOperation(operation.operationId)}>{language.t("common.cancel")}</Button>
                </div>
              )}</For>
            </div>
          </Show>
        </Tabs.Content>
      </Tabs>
    </div>
  )
}

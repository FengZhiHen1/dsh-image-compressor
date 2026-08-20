window.__ModuleLoader__.load({ id: "dsh-image-compressor", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
let react = require("react");
let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
let react_jsx_runtime = require("react/jsx-runtime");
//#region src/client/compressor.ts
/** 引擎可压缩的白名单格式（GIF 由拦截层跳过，引擎不接收，见 R-07）。 */
const COMPRESSIBLE_TYPES = /* @__PURE__ */ new Set([
	"image/png",
	"image/jpeg",
	"image/jpg",
	"image/webp"
]);
const EXT_BY_MIME = {
	"image/jpeg": "jpg",
	"image/png": "png",
	"image/webp": "webp"
};
/** 质量迭代步降序列（compression-engine.md 第 5 步）。 */
const QUALITY_STEPS = [
	.85,
	.7,
	.5,
	.3,
	.15
];
/** 总轮次上限（质量轮 + 尺寸轮合并计数）。 */
const MAX_ROUNDS = 6;
/** 尺寸耗尽后缩小因子。 */
const DOWNSIZE_FACTOR = .75;
/** 判断某文件类型是否为引擎可压缩格式。 */
function isCompressibleType(type) {
	return COMPRESSIBLE_TYPES.has(type);
}
/** 字节预筛（byte-prescreen-pixel-2026-08）：仅比较 size > maxImageBytes，零成本。 */
function shouldProcess(file, limits) {
	return file.size > limits.maxImageBytes;
}
/**
* 像素等比缩放目标：超过 maxImagePixels 时等比缩至限制内（宽高比不变、不放大）。
* 使用 floor 保证 `width * height <= maxImagePixels`。
*/
function pixelTarget(width, height, maxPixels) {
	const pixels = width * height;
	if (pixels <= maxPixels) return {
		width,
		height
	};
	const ratio = Math.sqrt(maxPixels / pixels);
	return {
		width: Math.max(1, Math.floor(width * ratio)),
		height: Math.max(1, Math.floor(height * ratio))
	};
}
/**
* 格式选择（R-05/R-06）：JPEG → JPEG 重编码；PNG/WebP → WebP 优先（保 alpha），
* 不支持时 JPEG 白底兜底。GIF 不在此路径。
*/
function formatPlan(sourceType, webpSupported) {
	if (sourceType === "image/jpeg" || sourceType === "image/jpg") return { mime: "image/jpeg" };
	return webpSupported ? { mime: "image/webp" } : { mime: "image/jpeg" };
}
/** 输出文件名 = 原名主干 + 新扩展名；原名无扩展名时直接追加。 */
function outputNameOf(name, mime) {
	const ext = EXT_BY_MIME[mime] ?? "img";
	const dot = name.lastIndexOf(".");
	return `${dot <= 0 ? name : name.slice(0, dot)}.${ext}`;
}
/** 浏览器默认宿主：createImageBitmap（EXIF from-image 自动纠正）+ canvas + toBlob。 */
function createBrowserCompressHost() {
	let webpSupport;
	return {
		decode(file) {
			return window.createImageBitmap(file, { imageOrientation: "from-image" });
		},
		canvas(width, height) {
			const element = document.createElement("canvas");
			element.width = width;
			element.height = height;
			const ctx = element.getContext("2d");
			if (ctx === null) throw new Error("canvas 2d context unavailable");
			return {
				width,
				height,
				backing: element,
				draw(bitmap, drawWidth, drawHeight) {
					ctx.drawImage(bitmap, 0, 0, drawWidth, drawHeight);
				},
				fillWhite() {
					ctx.fillStyle = "#ffffff";
					ctx.fillRect(0, 0, width, height);
				}
			};
		},
		encode(canvas, mime, quality) {
			const element = canvas.backing;
			return new Promise((resolve) => {
				element.toBlob((blob) => resolve(blob), mime, quality);
			});
		},
		async supportsWebp() {
			if (webpSupport !== void 0) return webpSupport;
			const canvas = document.createElement("canvas");
			canvas.width = 1;
			canvas.height = 1;
			webpSupport = await new Promise((resolve) => {
				canvas.toBlob((blob) => resolve((blob?.type ?? "") === "image/webp"), "image/webp");
			});
			return webpSupport;
		}
	};
}
function keepBest(best, blob) {
	if (best === null || blob.size < best.bytes) return {
		blob,
		bytes: blob.size
	};
	return best;
}
/**
* 压缩管线（单图）。任一阶段异常/解码失败按 `failed` 原样返回（失败兜底，R-09）；
* 迭代耗尽仍超限返回最小历史结果并标 `overLimit`（尽力而为）。
*/
async function compressImage(file, limits, host = createBrowserCompressHost()) {
	const originalBytes = file.size;
	const passthrough = () => ({
		file,
		originalName: file.name,
		changed: false,
		originalBytes,
		status: "unchanged",
		overLimit: false,
		formatChanged: false
	});
	const failedOriginal = () => ({
		file,
		originalName: file.name,
		changed: false,
		originalBytes,
		status: "failed",
		overLimit: false,
		formatChanged: false
	});
	if (!isCompressibleType(file.type) || !shouldProcess(file, limits)) return passthrough();
	let bitmap;
	try {
		bitmap = await host.decode(file);
	} catch {
		return failedOriginal();
	}
	try {
		const webpSupported = await host.supportsWebp();
		const { mime } = formatPlan(file.type, webpSupported);
		const needWhiteForJpeg = mime === "image/jpeg";
		const target = bitmap.width * bitmap.height > limits.maxImagePixels ? pixelTarget(bitmap.width, bitmap.height, limits.maxImagePixels) : {
			width: bitmap.width,
			height: bitmap.height
		};
		let best = null;
		let rounds = 0;
		let width = target.width;
		let height = target.height;
		let success = null;
		while (rounds < 6 && success === null) {
			const canvas = host.canvas(width, height);
			if (needWhiteForJpeg) canvas.fillWhite();
			canvas.draw(bitmap, width, height);
			for (const quality of QUALITY_STEPS) {
				if (rounds >= 6) break;
				rounds += 1;
				let blob = null;
				try {
					blob = await host.encode(canvas, mime, quality);
				} catch {
					blob = null;
				}
				if (blob === null) continue;
				best = keepBest(best, blob);
				if (blob.size <= limits.maxImageBytes) {
					success = {
						blob,
						overLimit: false
					};
					break;
				}
			}
			if (success === null) {
				const nextWidth = Math.max(1, Math.round(width * DOWNSIZE_FACTOR));
				const nextHeight = Math.max(1, Math.round(height * DOWNSIZE_FACTOR));
				if (nextWidth >= width && nextHeight >= height) break;
				width = nextWidth;
				height = nextHeight;
			}
		}
		if (success !== null) return {
			file: new File([success.blob], outputNameOf(file.name, mime), { type: mime }),
			originalName: file.name,
			changed: true,
			originalBytes,
			status: "compressed",
			overLimit: false,
			formatChanged: mime !== file.type
		};
		if (best !== null) return {
			file: new File([best.blob], outputNameOf(file.name, mime), { type: mime }),
			originalName: file.name,
			changed: true,
			originalBytes,
			status: "compressed",
			overLimit: true,
			formatChanged: mime !== file.type
		};
		return failedOriginal();
	} finally {
		try {
			bitmap.close();
		} catch {}
	}
}
//#endregion
//#region src/client/intake.ts
/**
* 摄入拦截与注入（intake-interception.md，追溯 R-02/R-03/R-09/R-10/R-11）。
*
* - `shouldTakeOver`：事件回调内全同步判定（防重入 / 无会话 / 忙 / 无投影 /
*   非可压缩图 / 字节未超限 → 放行）。
* - `processBatch`：接管后串行逐张处理，GIF 与失败张原文件入列，顺序与
*   不变量（任何图片不因本插件消失）由本函数保证。
* - `attachIntakeListeners`：document 捕获阶段 drop/paste 监听；dispose 移除。
* - `injectDrop`：构造 DataTransfer + DragEvent 重新喂入官方 document 监听。
*/
/** 防重入标记：注入事件对象上挂本插件私有符号。 */
const INJECTION_MARK = Symbol.for("dsh-image-compressor.injection");
/**
* 同步判定（R-03 字节预筛 + R-10 状态感知）。任一条件不满足即放行。
* 仅当存在任一张可压缩图片且其字节 > maxImageBytes 时接管。
*/
function shouldTakeOver(facts) {
	if (facts.injected) return false;
	if (!facts.hasSession) return false;
	if (facts.running) return false;
	if (facts.limits === void 0) return false;
	const maxImageBytes = facts.limits.maxImageBytes;
	const compressible = facts.files.filter((file) => isCompressibleType(file.type));
	if (compressible.length === 0) return false;
	return compressible.some((file) => file.size > maxImageBytes);
}
/** 运行时投影防御：非负数值检查失败即视为无投影（AC-11 放行）。 */
function asImageLimits(value) {
	if (typeof value !== "object" || value === null) return void 0;
	const record = value;
	if (typeof record.maxImageBytes !== "number" || typeof record.maxImagePixels !== "number") return void 0;
	if (!(record.maxImageBytes > 0) || !(record.maxImagePixels > 0)) return void 0;
	return {
		maxImageBytes: record.maxImageBytes,
		maxImagePixels: record.maxImagePixels
	};
}
/**
* 串行处理整批次（不并行，见内存边界）：GIF/非图片以原文件入列；可压缩图
* 单张调用 `compress`；引擎异常由本函数兜底为失败原样。返回按原始顺序排列。
*/
async function processBatch(files, limits, compress) {
	const items = [];
	let images = 0;
	let compressed = 0;
	let failed = 0;
	let overLimit = 0;
	let totalBefore = 0;
	let totalAfter = 0;
	const changedToSet = /* @__PURE__ */ new Set();
	for (const file of files) {
		totalBefore += file.size;
		const originalIndex = items.length;
		if (!isCompressibleType(file.type)) {
			totalAfter += file.size;
			items.push({
				file,
				originalName: file.name,
				changed: false,
				originalBytes: file.size,
				status: "unchanged",
				overLimit: false,
				formatChanged: false,
				originalIndex
			});
			continue;
		}
		images += 1;
		let result;
		try {
			result = await compress(file, limits);
		} catch {
			result = {
				file,
				originalName: file.name,
				changed: false,
				originalBytes: file.size,
				status: "failed",
				overLimit: false,
				formatChanged: false
			};
		}
		if (result.status === "compressed") {
			compressed += 1;
			if (result.overLimit) overLimit += 1;
			if (result.formatChanged) {
				if (result.file.type === "image/webp") changedToSet.add("webp");
				else if (result.file.type === "image/jpeg") changedToSet.add("jpeg");
			}
		} else if (result.status === "failed") failed += 1;
		totalAfter += result.file.size;
		items.push({
			...result,
			originalIndex
		});
	}
	return {
		items,
		images,
		compressed,
		failed,
		overLimit,
		totalBefore,
		totalAfter,
		changedTo: [...changedToSet]
	};
}
/** 事件对象上防重入标记读取。 */
function isMarked(event, mark = INJECTION_MARK) {
	return event[mark] === true;
}
/** 读取 drop 事件的拖放文件（非图片拖放同样读取，判定决定是否接管）。 */
function filesOfDrop(event) {
	return [...event.dataTransfer?.files ?? []];
}
/** 读取 paste 事件的剪贴板文件（React 合成事件由捕获阻断，这里读原生 ClipboardEvent）。 */
function filesOfPaste(event) {
	const items = event.clipboardData?.items;
	if (items === void 0) return [];
	const files = [];
	for (let i = 0; i < items.length; i += 1) {
		const item = items[i];
		if (item.kind !== "file") continue;
		const file = item.getAsFile();
		if (file !== null) files.push(file);
	}
	return files;
}
/**
* 注入：按原始顺序构造 DataTransfer 逐项 add，派发 document 冒泡 drop 事件，
* 事件对象挂防重入标记。返回是否成功派发。
*/
function injectDrop(files, mark = INJECTION_MARK) {
	if (files.length === 0) return true;
	const dataTransfer = new DataTransfer();
	for (const file of files) dataTransfer.items.add(file);
	const event = new DragEvent("drop", {
		bubbles: true,
		cancelable: true,
		dataTransfer
	});
	event[mark] = true;
	return document.dispatchEvent(event);
}
/**
* 收集一次事件的判定事实（纯读，零副作用）。limits 缺失 → 放行。
*/
function collectFacts(deps, event, files) {
	const current = deps.sessions.list.getSnapshot().current;
	const binding = current === void 0 ? void 0 : deps.sessions.binding(current);
	let limits;
	const projection = binding?.session.projections.faceOf("imageLimits").getSnapshot();
	limits = asImageLimits(projection);
	return {
		injected: isMarked(event),
		hasSession: current !== void 0,
		running: binding?.session.getSnapshot().running ?? false,
		limits,
		files
	};
}
/**
* 注册 document 捕获阶段 drop/paste 监听。判定放行时不干预；
* 接管时 preventDefault + stopPropagation 并异步处理批次后注入。
* 拦截器自身异常 → 返回（原事件未被 preventDefault，官方流程原样）。返回 disposer。
*/
function attachIntakeListeners(deps, mark = INJECTION_MARK) {
	const readFiles = (event) => {
		try {
			if (event.type === "drop") return filesOfDrop(event);
			return filesOfPaste(event);
		} catch {
			return;
		}
	};
	const onCapture = (event) => {
		const files = readFiles(event);
		if (files === void 0 || files.length === 0) return;
		let facts;
		try {
			facts = collectFacts(deps, event, files);
		} catch {
			return;
		}
		if (!shouldTakeOver(facts)) return;
		const limits = facts.limits;
		if (limits === void 0) return;
		event.preventDefault();
		event.stopPropagation();
		const fromPaste = event.type === "paste";
		(async () => {
			try {
				const batch = await processBatch(files, limits, deps.compress);
				try {
					deps.onDone(batch, fromPaste);
				} catch {}
				injectDrop(batch.items.map((item) => item.file), mark);
			} catch {
				try {
					injectDrop(files, mark);
				} catch {}
			}
		})();
	};
	document.addEventListener("drop", onCapture, true);
	document.addEventListener("paste", onCapture, true);
	return () => {
		document.removeEventListener("drop", onCapture, true);
		document.removeEventListener("paste", onCapture, true);
	};
}
//#endregion
//#region src/client/locales.ts
/**
* 文案表与通知文案聚合（notification.md，追溯 R-08/R-09）。
*
* zh/en 词典在 `IMAGE_COMPRESSOR_NS` 命名空间；`buildNotification` 为纯函数，
* 输入批次摘要 + 当前语言的 translate，输出一条聚合结果的 Toast 文案与图标语义。
*/
/** 本插件专属 locale 命名空间（注册进 DSH LocaleNamespaceMap）。 */
const IMAGE_COMPRESSOR_NS = "image-compressor";
const en = {
	"compressed.single": "Auto-compressed: {name} {before} → {after}{formatNote}",
	"compressed.multi": "Auto-compressed {count} images ({before} → {after} total){formatNote}",
	"compressed.partial": "Compressed {ok} image(s); {failed} failed and were added as-is",
	"compressed.allFailed": "{failed} image(s) failed to compress and were added as-is",
	"compressed.overLimit": "Compressed: {name} {before} → {after} (still over the limit; try another image)",
	"compressed.overLimitWithin": "; {count} still over the limit",
	"common.formatChanged": " (converted to {format})",
	"paste.textDropped": "; clipboard text was not pasted with the images"
};
const zh = {
	"compressed.single": "已自动压缩：{name} {before} → {after}{formatNote}",
	"compressed.multi": "已自动压缩 {count} 张图片（共 {before} → {after}）{formatNote}",
	"compressed.partial": "已压缩 {ok} 张图片；{failed} 张压缩失败，已按原图添加",
	"compressed.allFailed": "{failed} 张图片压缩失败，已按原图添加",
	"compressed.overLimit": "已压缩：{name} {before} → {after}（仍超出限制，建议更换图片）",
	"compressed.overLimitWithin": "；{count} 张仍超出限制",
	"common.formatChanged": "（已转为 {format}）",
	"paste.textDropped": "；剪贴板文本未随图片粘贴"
};
/** 字节朗读：≥1MB 显示 MB（1 位小数），≥1KB 显示 KB，否则 B。 */
function formatBytes(bytes) {
	if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)}MB`;
	if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	return `${bytes}B`;
}
function formatNoteOf(summary, t) {
	if (summary.changedTo.length === 0 || summary.compressed === 0) return "";
	const [first, second] = summary.changedTo;
	const label = second === void 0 ? first === "webp" ? "WebP" : first === "jpeg" ? "JPEG" : "" : "WebP/JPEG";
	if (label === "") return "";
	return t("common.formatChanged", { format: label });
}
/**
* 聚合批次摘要为一条通知（R-08 单条聚合、R-09 失败/尽力而为如实报告）。
* 未接管到任何可报告工作（压缩/失败都为零）→ 返回 null（不通知，AC-03）。
*/
function buildNotification(summary, t) {
	if (!(summary.compressed > 0 || summary.failed > 0)) return null;
	const single = summary.images === 1 && summary.compressed === 1 && summary.failed === 0 && summary.fileName !== null;
	const formatNote = formatNoteOf(summary, t);
	const overLimitWithin = summary.overLimit > 0 && !single ? t("compressed.overLimitWithin", { count: String(summary.overLimit) }) : "";
	let text;
	if (single && summary.overLimit > 0) text = t("compressed.overLimit", {
		name: summary.fileName ?? "",
		before: formatBytes(summary.firstBefore),
		after: formatBytes(summary.firstAfter)
	});
	else if (single) text = t("compressed.single", {
		name: summary.fileName ?? "",
		before: formatBytes(summary.firstBefore),
		after: formatBytes(summary.firstAfter),
		formatNote
	});
	else if (summary.compressed > 0 && summary.failed === 0) text = t("compressed.multi", {
		count: String(summary.compressed),
		before: formatBytes(summary.totalBefore),
		after: formatBytes(summary.totalAfter),
		formatNote
	}) + overLimitWithin;
	else if (summary.compressed > 0 && summary.failed > 0) text = t("compressed.partial", {
		ok: String(summary.compressed),
		failed: String(summary.failed)
	}) + overLimitWithin;
	else text = t("compressed.allFailed", { failed: String(summary.failed) });
	if (summary.fromPaste) text += t("paste.textDropped");
	const kind = summary.failed > 0 || summary.overLimit > 0 ? "warning" : "info";
	return {
		text,
		kind
	};
}
//#endregion
//#region src/client/notify-store.ts
/**
* 通知队列 store（notification.md，追溯 R-08/R-09）。
*
* 模块级订阅 store（参照 dsh-openpencil-lite preview-store 模式）：拦截层在
* 批次完成时 `publish`（聚合一条，R-08 避免逐张刷屏），通知层组件
* `useSyncExternalStore` 订阅；Toast `onDone` 出队。apply 生命周期内初始化
* （reset），dispose 清空（R-11 零残留）；已清空时 publish 为空操作。
*/
/** ProcessedBatch → NotificationSummary 的纯桥梁（批量单/多、失败、尽力而为派生）。 */
function summaryOf(batch, fromPaste) {
	const compressedItems = batch.items.filter((item) => item.status === "compressed");
	const single = batch.images === 1 && batch.failed === 0 && compressedItems.length === 1 ? compressedItems[0] : void 0;
	return {
		images: batch.images,
		compressed: batch.compressed,
		failed: batch.failed,
		overLimit: batch.overLimit,
		changedTo: batch.changedTo,
		fromPaste,
		totalBefore: batch.totalBefore,
		totalAfter: batch.totalAfter,
		fileName: single?.originalName ?? null,
		firstBefore: single?.originalBytes ?? 0,
		firstAfter: single?.file.size ?? 0
	};
}
/** 聚合批次为一条通知文案与语义；无工作报告（未接管）返回 null（不通知）。 */
function messageOf(batch, fromPaste, translate) {
	return buildNotification(summaryOf(batch, fromPaste), translate);
}
let items = [];
let seq = 0;
const listeners = /* @__PURE__ */ new Set();
function notify() {
	for (const listener of [...listeners]) try {
		listener();
	} catch {}
}
/** apply 初始化或测试隔离：清空队列与序号并通知。 */
function resetNotifyStore() {
	items = [];
	seq = 0;
	notify();
}
/** dispose 清空（R-11）。已清空时重复清空为空操作。 */
function clearNotifyStore() {
	items = [];
	notify();
}
/** 队列快照（uSES getSnapshot；引用在每次变更后替换，稳定协议）。 */
function getNotifySnapshot() {
	return items;
}
/** 订阅队列变更；返回取消订阅函数。 */
function subscribeNotify(listener) {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}
/** 入队一条通知（聚合好的单条）。 */
function publish(message) {
	seq += 1;
	items = [...items, {
		seq,
		text: message.text,
		kind: message.kind
	}];
	notify();
	return true;
}
/** 按序号出队（Toast onDone）；不存在的序号为空操作。 */
function dismiss(sequence) {
	if (!items.some((item) => item.seq === sequence)) return;
	items = items.filter((item) => item.seq !== sequence);
	notify();
}
//#endregion
//#region src/client/Notifications.tsx
/**
* 通知层组件（notification.md，追溯 R-08/R-09）。
*
* 注册在 `conversation.input.dock` 会话级 list 座位，渲染 null 布局；队列非空
* 时渲染官方 Toast（text + 图标 + anchor + onDone 出队），Toast 自带 portal 到
* body，不占布局、不干扰输入条。anchor 参照官方 InputBar 自身 Toast 的做法
* 定位到 composer 卡片（`[data-composer-card]`）；缺失时按 viewport 居中降级。
*/
/**
* Dock 条目组件：订阅通知队列，逐条展示 Toast，出队后展示下一条。
* 队列空时渲染 null（座位占位，无可见副作用）。
*/
function NotificationDock() {
	const items = (0, react.useSyncExternalStore)(subscribeNotify, getNotifySnapshot, getNotifySnapshot);
	const [anchor, setAnchor] = (0, react.useState)(null);
	(0, react.useEffect)(() => {
		setAnchor(document.querySelector("[data-composer-card]"));
	}, []);
	const head = items.length > 0 ? items[0] : void 0;
	if (head === void 0) return null;
	const icon = head.kind === "warning" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconWarningOutline16, {}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconCheckOutline16, {});
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Toast, {
		text: head.text,
		icon,
		anchor,
		onDone: () => {
			dismiss(head.seq);
		}
	}, head.seq);
}
//#endregion
//#region src/client/index.tsx
/** Required services (service-oriented reads, hard deps of the web shell). */
const inject = [
	"sessions",
	"slots",
	"locale"
];
/**
* Client plugin body（阶段5 完整集成）：
* 1. 注册 zh/en 词典（ctx.effect 随 Fiber 卸载反注册）。
* 2. 初始化通知队列。
* 3. document 捕获阶段 drop/paste 监听 + 完成后 publish 聚合通知；dispose 移除并清空队列。
* 4. 通知层挂到 `conversation.input.dock` 会话级座位。
*/
function apply(ctx) {
	ctx.effect(() => ctx.locale.register(IMAGE_COMPRESSOR_NS, {
		zh,
		en
	}), "dsh-image-compressor: dictionaries");
	resetNotifyStore();
	ctx.effect(() => {
		const translate = ctx.locale.bind(IMAGE_COMPRESSOR_NS);
		const detach = attachIntakeListeners({
			sessions: ctx.sessions,
			compress: compressImage,
			onDone: (batch, fromPaste) => {
				const message = messageOf(batch, fromPaste, translate);
				if (message !== null) publish(message);
			}
		});
		return () => {
			detach();
			clearNotifyStore();
		};
	}, "dsh-image-compressor: intake + notification lifecycle");
	ctx.slots.inject("conversation.input.dock", () => ctx.slots.register({
		name: "conversation.input.dock",
		id: "dsh-image-compressor",
		order: 20,
		locale: IMAGE_COMPRESSOR_NS
	}, NotificationDock));
}
//#endregion
exports.DOWNSIZE_FACTOR = DOWNSIZE_FACTOR;
exports.EXT_BY_MIME = EXT_BY_MIME;
exports.IMAGE_COMPRESSOR_NS = IMAGE_COMPRESSOR_NS;
exports.INJECTION_MARK = INJECTION_MARK;
exports.MAX_ROUNDS = MAX_ROUNDS;
exports.NotificationDock = NotificationDock;
exports.QUALITY_STEPS = QUALITY_STEPS;
exports.apply = apply;
exports.asImageLimits = asImageLimits;
exports.attachIntakeListeners = attachIntakeListeners;
exports.buildNotification = buildNotification;
exports.clearNotifyStore = clearNotifyStore;
exports.compressImage = compressImage;
exports.createBrowserCompressHost = createBrowserCompressHost;
exports.dismiss = dismiss;
exports.en = en;
exports.filesOfDrop = filesOfDrop;
exports.filesOfPaste = filesOfPaste;
exports.formatBytes = formatBytes;
exports.formatPlan = formatPlan;
exports.getNotifySnapshot = getNotifySnapshot;
exports.inject = inject;
exports.injectDrop = injectDrop;
exports.isCompressibleType = isCompressibleType;
exports.isMarked = isMarked;
exports.messageOf = messageOf;
exports.outputNameOf = outputNameOf;
exports.pixelTarget = pixelTarget;
exports.processBatch = processBatch;
exports.publish = publish;
exports.resetNotifyStore = resetNotifyStore;
exports.shouldProcess = shouldProcess;
exports.shouldTakeOver = shouldTakeOver;
exports.subscribeNotify = subscribeNotify;
exports.summaryOf = summaryOf;
exports.zh = zh;

return module.exports; } });

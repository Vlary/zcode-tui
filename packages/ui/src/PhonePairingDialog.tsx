import { useEffect, useState, type ReactNode } from "react";
import QRCode from "qrcode";
import { LoaderCircle, Smartphone, TriangleAlertIcon } from "lucide-react";
import type { WebRemoteControlFailure } from "@zcode/shared";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { getFailureDescription } from "@/web-remote-control/domain/presentation.js";

/**
 * GET /api/web-remote-control/pairing 的响应。Web 前端不依赖 @zcode/server，
 * 按 server/src/http.ts 的 WebRemoteControlPairingInfo 契约同构声明
 * （server-info 的读取在 web main.tsx 也是同样的本地类型方式）。
 * failure 为容错字段：server 侧 error 态未携带时回退到通用文案。
 */
interface PhonePairingInfo {
  enabled: boolean;
  status: "off" | "waiting-terminal" | "paired" | "error";
  qrUrl?: string;
  deviceName?: string;
  relayWsUrl?: string;
  failure?: { reason: string; message?: string };
}

/** 配对面板轮询间隔（约 2s）。 */
const PHONE_PAIRING_POLL_INTERVAL_MS = 2000;
const PHONE_PAIRING_QR_WIDTH = 320;

/**
 * Web UI 账户浮层"手机配对"面板：轮询 Server 被控端（device relay）状态，
 * waiting-terminal 渲染配对二维码（qrUrl 由 Server 生成，starting 阶段缺省，
 * 以 loading 占位），paired/error/off 分别展示对应态。
 */
export function PhonePairingDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { intl } = useZCodeIntl();
  const [info, setInfo] = useState<PhonePairingInfo | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setInfo(null);
      return;
    }
    let cancelled = false;
    const pollPairingInfo = async () => {
      try {
        const response = await fetch("/api/web-remote-control/pairing", { cache: "no-store" });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const data = (await response.json()) as PhonePairingInfo;
        if (!cancelled) {
          setInfo(data);
        }
      } catch (error) {
        // 单次轮询失败保留上一次状态，下一个周期继续重试；从未成功时维持 loading。
        const message = error instanceof Error ? error.message : String(error);
        logger.warn("[PhonePairingDialog] 轮询手机配对状态失败", message);
      }
    };
    void pollPairingInfo();
    const intervalId = window.setInterval(() => {
      void pollPairingInfo();
    }, PHONE_PAIRING_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [open]);

  useEffect(() => {
    if (!info?.qrUrl) {
      setQrDataUrl(null);
      return;
    }

    let cancelled = false;
    setQrDataUrl(null);

    void QRCode.toDataURL(info.qrUrl, {
      margin: 1,
      width: PHONE_PAIRING_QR_WIDTH,
    })
      .then((dataUrl: string) => {
        if (!cancelled) {
          setQrDataUrl(dataUrl);
        }
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("[PhonePairingDialog] 生成二维码失败", message);
      });

    return () => {
      cancelled = true;
    };
  }, [info?.qrUrl]);

  const deviceNameRow = info?.deviceName ? (
    <div className="text-ui-sm text-foreground-subtle">
      {intl.formatMessage({ id: "phonePairing.device" }, { name: info.deviceName })}
    </div>
  ) : null;

  let pairingContent: ReactNode;
  if (!info) {
    pairingContent = (
      <div className="flex flex-col items-center gap-3 py-6 text-center text-foreground-subtle">
        <LoaderCircle className="size-5 animate-spin" />
        <span>{intl.formatMessage({ id: "common.loading" })}</span>
      </div>
    );
  } else if (info.status === "error") {
    // 优先复用远控失败原因的既有本地化映射；未知 reason 回退 failure.message/通用文案。
    const failureText = info.failure
      ? (getFailureDescription(info.failure as WebRemoteControlFailure, intl.formatMessage) ??
        info.failure.message ??
        intl.formatMessage({ id: "phonePairing.error" }))
      : intl.formatMessage({ id: "phonePairing.error" });
    pairingContent = (
      <div className="flex flex-col items-center gap-3 py-6 text-center">
        <TriangleAlertIcon className="size-8 text-warning opacity-60" />
        <div className="text-ui-base text-foreground">{failureText}</div>
        {deviceNameRow}
      </div>
    );
  } else if (!info.enabled || info.status === "off") {
    pairingContent = (
      <div className="flex flex-col items-center gap-3 py-6 text-center">
        <Smartphone className="size-8 text-foreground-subtle" />
        <div className="text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "phonePairing.notEnabled" })}
        </div>
      </div>
    );
  } else if (info.status === "paired") {
    pairingContent = (
      <div className="flex flex-col items-center gap-3 py-6 text-center">
        <Smartphone className="size-8 text-foreground-subtle" />
        <div className="text-ui-base font-medium text-foreground">
          {intl.formatMessage({ id: "phonePairing.paired" })}
        </div>
        {deviceNameRow}
      </div>
    );
  } else {
    pairingContent = (
      <div className="flex flex-col items-center gap-4">
        <div className="flex w-full items-center justify-center rounded-xl border border-dashed border-border bg-background-alt p-4">
          {qrDataUrl ? (
            <img
              src={qrDataUrl}
              alt={intl.formatMessage({ id: "phonePairing.qrAlt" })}
              className="size-56 max-w-full rounded-lg bg-white p-3"
            />
          ) : (
            <div className="flex size-56 flex-col items-center justify-center gap-3 text-center text-ui-base text-foreground-subtle">
              <LoaderCircle className="size-5 animate-spin" />
              <span>{intl.formatMessage({ id: "webRemoteControl.generating" })}</span>
            </div>
          )}
        </div>
        {deviceNameRow}
        <div className="text-ui-base text-foreground">
          {intl.formatMessage({ id: "phonePairing.waiting" })}
        </div>
      </div>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{intl.formatMessage({ id: "phonePairing.title" })}</DialogTitle>
          <DialogDescription>
            {intl.formatMessage({ id: "phonePairing.description" })}
          </DialogDescription>
        </DialogHeader>
        {pairingContent}
      </DialogContent>
    </Dialog>
  );
}

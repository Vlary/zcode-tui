import { SocketProtocol, type ISocket } from "@zcode/rpc";
import type { AcknowledgedWebRemoteControlRelayProtocolAdapter } from "@zcode/client";
import { createInMemorySocketPair } from "./webRemoteControlRelaySocket.js";

/**
 * Web 远程控制被控端的进程内桥：acknowledged relay rpc-frame 流 ↔ ChannelServer。
 *
 * desktop 侧（manager:1283-1330）用 Electron UtilityProcess 的 MessagePortMain 对
 * （wrapElectronPort + MessagePortProtocol）承载 host 端；server 没有 UtilityProcess，
 * 改用进程内 ISocket 对：left 交给 attachChannelServer（生产装配为
 * http.ts 的 setupChannelServerOverSocket，与 /ws 的 web-remote-replayable 同一形态），
 * right 由 SocketProtocol 分帧后与 acknowledged relay protocol 双向直通。
 */

export interface WebRemoteControlChannelBridgeAttachment {
  dispose(): void;
}

export interface WebRemoteControlChannelBridgeOptions {
  /**
   * 生产装配：setupChannelServerOverSocket(services, "web-remote-replayable", ...) 的闭包。
   * ChannelServer 的释放由其内部 socket.onClose 驱动；桥 dispose 时关闭 left 触发该清理。
   */
  attachChannelServer(socket: ISocket): void;
  relayProtocol: AcknowledgedWebRemoteControlRelayProtocolAdapter;
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
  };
}

export function createWebRemoteControlChannelBridge(
  options: WebRemoteControlChannelBridgeOptions,
): WebRemoteControlChannelBridgeAttachment {
  const { left, right } = createInMemorySocketPair();
  options.attachChannelServer(left);
  const hostProtocol = new SocketProtocol(right);

  // host(ChannelServer) → relay：acknowledged adapter 是唯一 replay owner。
  const disposeHostToRelay = hostProtocol.onMessage((buffer) => {
    options.relayProtocol.protocol.send(buffer);
  });
  const disposeRelayToHost = options.relayProtocol.protocol.onMessage((buffer) => {
    hostProtocol.send(buffer);
  });
  // 进程内管道没有可反压的传输层：acknowledged 协议自身的 replayBuffer/watermark
  // 已界定未 ACK 内存；saturated/drained 在这里只保留日志语义（desktop 侧对应
  // MessagePortProtocol.sendFlowState，SocketProtocol 无该通道）。
  const disposeSaturated = options.relayProtocol.onSaturated(() => {
    options.logger.info("[web-remote-control:server] relay bridge saturated");
  });
  const disposeDrained = options.relayProtocol.onDrained(() => {
    options.logger.info("[web-remote-control:server] relay bridge drained");
  });
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    disposeHostToRelay.dispose();
    disposeRelayToHost.dispose();
    disposeSaturated.dispose();
    disposeDrained.dispose();
    hostProtocol.dispose();
    // left/right 关闭会触发 ChannelServer 侧 onClose 清理（setupChannelServerOverSocket 内部）。
    left.dispose();
    right.dispose();
  };
  // 桥的任一端关闭都释放整条链：ChannelServer 拆除或 relay socket 断开。
  left.onClose(dispose);
  right.onClose(dispose);
  return { dispose };
}

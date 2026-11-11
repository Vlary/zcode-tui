import { Emitter, type ISocket, type VSBuffer } from "@zcode/rpc";

/**
 * 进程内 ISocket 对：形态对齐 http.ts:48-85 的 wrapWebSocket（onData/onClose/onEnd 事件 +
 * write/end/drain/dispose），只是不经真实 WebSocket host。
 *
 * 用于 Web 远程控制被控端：一端交给 ChannelServer（setupChannelServerOverSocket），
 * 另一端由 SocketProtocol 承载 acknowledged relay 的 rpc-frame 流，
 * 替代 desktop manager:1283 的 wrapElectronPort(UtilityProcess MessagePortMain)。
 *
 * 与 @zcode/rpc 的 createQueuePair 不同，这里保留 onClose/onEnd 语义：
 * 任一端 end/dispose，对端也会收到 close+end，保证 ChannelServer 与 relay 两侧都释放。
 */

interface SocketEmitters {
  data: Emitter<VSBuffer>;
  close: Emitter<void>;
  end: Emitter<void>;
}

interface InMemorySocketContext {
  own: SocketEmitters;
  peer: SocketEmitters;
}

function createInMemorySocket(context: InMemorySocketContext): ISocket {
  const { own, peer } = context;
  let disposed = false;
  // fromPeer=true 表示关闭由对端传播而来，不再反向传播，避免重复 fire。
  const teardown = (fromPeer: boolean) => {
    if (disposed) return;
    disposed = true;
    own.close.fire();
    own.end.fire();
    own.data.dispose();
    own.close.dispose();
    own.end.dispose();
    if (!fromPeer) {
      peer.close.fire();
      peer.end.fire();
    }
  };
  return {
    onData: own.data.event,
    onClose: own.close.event,
    onEnd: own.end.event,
    write(buffer) {
      if (disposed) return;
      // 与 createQueuePair 一致用宏任务投递，模拟真实 socket 的异步到达，
      // 避免 ChannelServer 请求/响应在同一条同步栈上重入。
      setTimeout(() => {
        if (!disposed) peer.data.fire(buffer);
      }, 0);
    },
    end() {
      teardown(false);
    },
    drain() {
      return Promise.resolve();
    },
    dispose() {
      teardown(false);
    },
  };
}

export interface InMemorySocketPair {
  /** 交给 ChannelServer 的一端。 */
  left: ISocket;
  /** 由 SocketProtocol 承载 acknowledged relay rpc-frame 流的一端。 */
  right: ISocket;
}

export function createInMemorySocketPair(): InMemorySocketPair {
  const leftEmitters: SocketEmitters = {
    data: new Emitter<VSBuffer>(),
    close: new Emitter<void>(),
    end: new Emitter<void>(),
  };
  const rightEmitters: SocketEmitters = {
    data: new Emitter<VSBuffer>(),
    close: new Emitter<void>(),
    end: new Emitter<void>(),
  };
  return {
    left: createInMemorySocket({ own: leftEmitters, peer: rightEmitters }),
    right: createInMemorySocket({ own: rightEmitters, peer: leftEmitters }),
  };
}

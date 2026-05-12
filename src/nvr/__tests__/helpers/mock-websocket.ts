/**
 * Mock WebSocket for testing stream connections.
 *
 * Captures sent messages and allows simulating server responses.
 */
export class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  static instances: MockWebSocket[] = [];

  url: string;
  binaryType: string = "blob";
  readyState: number = MockWebSocket.CONNECTING;

  onopen: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;

  sentMessages: (string | ArrayBuffer)[] = [];

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);

    // Open immediately for synchronous test flow
    this.readyState = MockWebSocket.OPEN;
  }

  send(data: string | ArrayBuffer): void {
    if (this.readyState !== MockWebSocket.OPEN) {
      throw new Error("WebSocket is not open");
    }
    this.sentMessages.push(data);
  }

  close(): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.(new CloseEvent("close"));
  }

  /**
   * Simulate receiving a text message from the server.
   */
  simulateMessage(data: string | ArrayBuffer): void {
    this.onmessage?.({ data } as MessageEvent);
  }

  /**
   * Simulate a connection error.
   */
  simulateError(): void {
    this.onerror?.(new Event("error"));
  }

  /**
   * Reset all instances for test isolation.
   */
  static reset(): void {
    MockWebSocket.instances = [];
  }

  /**
   * Get the most recently created instance.
   */
  static get latest(): MockWebSocket | undefined {
    return MockWebSocket.instances[MockWebSocket.instances.length - 1];
  }
}

/**
 * Install MockWebSocket as the global WebSocket.
 * Returns a cleanup function.
 */
export function installMockWebSocket(): () => void {
  const original = globalThis.WebSocket;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).WebSocket = MockWebSocket as any;
  MockWebSocket.reset();
  return () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).WebSocket = original;
    MockWebSocket.reset();
  };
}

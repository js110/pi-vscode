/** Clipboard writes with a host fallback for sandboxed webviews. */
export class ClipboardBridge {
    private nextId = 0;
    private pending = new Map<number, () => void>();

    constructor(
        private post: (text: string, requestId: number) => void,
        private onError: (message?: string) => void,
    ) {}

    copy(text: string, onCopied: () => void): void {
        const fallback = () => {
            const requestId = ++this.nextId;
            this.pending.set(requestId, onCopied);
            this.post(text, requestId);
        };
        const clipboard = (navigator as Navigator & { clipboard?: Clipboard }).clipboard;
        if (clipboard?.writeText) {
            clipboard.writeText(text).then(onCopied, fallback);
        } else {
            fallback();
        }
    }

    resolve(requestId: number, ok: boolean, message?: string): void {
        const onCopied = this.pending.get(requestId);
        this.pending.delete(requestId);
        if (!onCopied) return;
        if (ok) onCopied();
        else this.onError(message);
    }
}

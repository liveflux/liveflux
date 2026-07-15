'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { cn } from '@/lib/cn';

/**
 * Copy-to-clipboard button for a code block. Writes `text` to the clipboard and
 * flips to a "Copied" confirmation for ~1.5s before reverting. The timer is
 * cleared on unmount and reset on repeat clicks so the label never desyncs.
 */
export function CopyButton({ text, className }: { text: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const onCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard can reject (permissions, insecure context) — fail quietly; the
      // static code stays selectable, so the user is never blocked.
    }
  }, [text]);

  return (
    <button
      type="button"
      onClick={onCopy}
      aria-label="Copy code"
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-fd-muted-foreground transition-colors hover:bg-fd-accent hover:text-fd-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fd-ring',
        className,
      )}
    >
      {copied ? (
        <>
          <Check className="size-3.5" aria-hidden />
          Copied
        </>
      ) : (
        <>
          <Copy className="size-3.5" aria-hidden />
          Copy
        </>
      )}
    </button>
  );
}

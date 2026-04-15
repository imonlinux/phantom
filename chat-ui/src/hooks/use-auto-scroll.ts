import { useCallback, useEffect, useRef, useState } from "react";

export function useAutoScroll(): {
  containerRef: React.RefObject<HTMLDivElement | null>;
  isAtBottom: boolean;
  scrollToBottom: (instant?: boolean) => void;
} {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const userScrolledRef = useRef(false);

  const scrollToBottom = useCallback((instant?: boolean) => {
    const el = containerRef.current;
    if (!el) return;
    userScrolledRef.current = false;
    setIsAtBottom(true);
    el.scrollTo({
      top: el.scrollHeight,
      behavior: instant ? "instant" : "smooth",
    });
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const threshold = 40;

    const handleScroll = (): void => {
      const atBottom =
        el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
      setIsAtBottom(atBottom);
      if (!atBottom) {
        userScrolledRef.current = true;
      }
    };

    const observer = new ResizeObserver(() => {
      if (!userScrolledRef.current) {
        el.scrollTo({ top: el.scrollHeight, behavior: "instant" });
      }
    });

    el.addEventListener("scroll", handleScroll, { passive: true });
    observer.observe(el);

    // Watch for child mutations to auto-scroll on new content
    const mutationObserver = new MutationObserver(() => {
      if (!userScrolledRef.current) {
        el.scrollTo({ top: el.scrollHeight, behavior: "instant" });
      }
    });
    mutationObserver.observe(el, { childList: true, subtree: true });

    return () => {
      el.removeEventListener("scroll", handleScroll);
      observer.disconnect();
      mutationObserver.disconnect();
    };
  }, []);

  return { containerRef, isAtBottom, scrollToBottom };
}

import { create } from "zustand";

export type Tab = "home" | "generate" | "pixelate" | "animate" | "voxelize" | "tiles" | "library";

interface AppState {
  tab: Tab;
  setTab: (t: Tab) => void;
  mock: boolean;
  setMock: (m: boolean) => void;
  balance: number | null;
  setBalance: (b: number | null) => void;
  // handoff: a sprite (data URL) sent from Generate/Pixelate into Animate
  spriteForAnimate: string | null;
  sendToAnimate: (dataUrl: string) => void;
  // handoff: an already-generated animation sheet sent into Animate's player to replay
  playAnimation: { sheet: string; frames: number; size: number } | null;
  openAnimation: (sheet: string, frames: number, size: number) => void;
}

export const useApp = create<AppState>((set) => ({
  tab: "home",
  setTab: (tab) => set({ tab }),
  mock: true,
  setMock: (mock) => set({ mock }),
  balance: null,
  setBalance: (balance) => set({ balance }),
  spriteForAnimate: null,
  sendToAnimate: (dataUrl) => set({ spriteForAnimate: dataUrl, tab: "animate" }),
  playAnimation: null,
  openAnimation: (sheet, frames, size) => set({ playAnimation: { sheet, frames, size }, tab: "animate" }),
}));

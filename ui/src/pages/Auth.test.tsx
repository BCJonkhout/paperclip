// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthPage } from "./Auth";

const { navigateMock, searchParams, signInKeycloakMock } = vi.hoisted(() => ({
  navigateMock: vi.fn(),
  searchParams: new URLSearchParams("next=%2Fdashboard"),
  signInKeycloakMock: vi.fn(),
}));

vi.mock("@/lib/router", () => ({
  useNavigate: () => navigateMock,
  useSearchParams: () => [searchParams],
}));

vi.mock("../api/auth", () => ({
  authApi: {
    getSession: vi.fn(async () => null),
    signInEmail: vi.fn(async () => undefined),
    signUpEmail: vi.fn(async () => undefined),
    signInKeycloak: signInKeycloakMock,
  },
}));

vi.mock("../api/health", () => ({
  healthApi: {
    get: vi.fn(async () => ({
      status: "ok",
      deploymentMode: "authenticated",
      features: {
        keycloakAuthEnabled: true,
      },
    })),
  },
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, ...props }: React.ComponentProps<"button">) => <button {...props}>{children}</button>,
}));

vi.mock("@/components/AsciiArtAnimation", () => ({
  AsciiArtAnimation: () => <div data-testid="ascii-art" />,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("AuthPage", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let assignMock: ReturnType<typeof vi.fn>;
  const originalLocation = window.location;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    assignMock = vi.fn();
    signInKeycloakMock.mockReset();
    signInKeycloakMock.mockResolvedValue({
      url: "https://login.prudai.com/realms/prudai/protocol/openid-connect/auth",
      redirect: true,
    });
    Object.defineProperty(window, "location", {
      configurable: true,
      value: {
        ...window.location,
        origin: "https://paperclip.prudai.com",
        assign: assignMock,
      },
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    navigateMock.mockReset();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: originalLocation,
    });
  });

  it("shows the SSO button and redirects through Keycloak", async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
        },
      },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <AuthPage />
        </QueryClientProvider>,
      );
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const ssoButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Sign in with SSO"),
    );

    expect(ssoButton).toBeDefined();

    await act(async () => {
      ssoButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(signInKeycloakMock).toHaveBeenCalledWith({
      callbackURL: "https://paperclip.prudai.com/dashboard",
      errorCallbackURL: "https://paperclip.prudai.com/auth?next=%2Fdashboard",
      newUserCallbackURL: "https://paperclip.prudai.com/dashboard",
    });
    expect(assignMock).toHaveBeenCalledWith(
      "https://login.prudai.com/realms/prudai/protocol/openid-connect/auth",
    );
  });
});

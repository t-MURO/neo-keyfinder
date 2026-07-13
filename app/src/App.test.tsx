import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { getNativeHealth } from "./lib/native-engine";

vi.mock("./lib/native-engine", () => ({
  getNativeHealth: vi.fn(),
}));

const mockedHealth = vi.mocked(getNativeHealth);

afterEach(cleanup);

describe("App", () => {
  beforeEach(() => {
    mockedHealth.mockReset();
  });

  it("shows the native engine contract when health succeeds", async () => {
    mockedHealth.mockResolvedValue({
      service: "keyfinder-native",
      engineVersion: "0.1.0",
      protocolVersion: 1,
    });

    render(<App />);

    expect(screen.getByRole("status")).toHaveTextContent("Checking engine");
    expect(await screen.findByText("Engine online")).toBeInTheDocument();
    expect(screen.getByText("keyfinder-native")).toBeInTheDocument();
    expect(screen.getByText("v0.1.0")).toBeInTheDocument();
  });

  it("surfaces a failed bridge and can retry", async () => {
    const user = userEvent.setup();
    mockedHealth
      .mockRejectedValueOnce(new Error("sidecar was not found"))
      .mockResolvedValueOnce({
        service: "keyfinder-native",
        engineVersion: "0.1.0",
        protocolVersion: 1,
      });

    render(<App />);

    expect(await screen.findByText("Engine offline")).toBeInTheDocument();
    expect(screen.getByText("sidecar was not found")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Check again" }));

    expect(await screen.findByText("Engine online")).toBeInTheDocument();
    expect(mockedHealth).toHaveBeenCalledTimes(2);
  });
});

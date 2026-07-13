import { invoke } from "@tauri-apps/api/core";

export interface NativeHealth {
  service: "keyfinder-native";
  engineVersion: string;
  protocolVersion: number;
}

export async function getNativeHealth(): Promise<NativeHealth> {
  return invoke<NativeHealth>("get_native_health");
}

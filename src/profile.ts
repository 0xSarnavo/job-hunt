import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { Profile } from "./types.ts";

export function loadProfile(path = "profile.yaml"): Profile {
  return Profile.parse(parse(readFileSync(path, "utf8")));
}

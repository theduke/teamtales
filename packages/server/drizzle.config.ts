import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  out: "./db/drizzle",
  dbCredentials: {
    url: process.env.TEAMTALES_DB ?? "teamtales.sqlite",
  },
});

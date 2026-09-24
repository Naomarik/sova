// Run: npx tsx --test server/sandbox-route-absent.test.ts (or npm test)
// sandbox-route.test.ts with no sandbox extension in the agent dir: Sova as it is without it.
process.env.PI_SANDBOX_ROUTE_ABSENT = "1";
await import("./sandbox-route.test.ts");
export {};

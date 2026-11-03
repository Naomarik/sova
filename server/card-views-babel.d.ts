// The two Babel modules server/card-views.ts uses, typed as far as it uses them (their own types
// aren't a dependency of Sova's).
declare module "@babel/core" {
  export function transformAsync(code: string, options: Record<string, unknown>): Promise<{ code?: string | null } | null>;
}
declare module "babel-preset-solid" {
  const preset: unknown;
  export default preset;
}

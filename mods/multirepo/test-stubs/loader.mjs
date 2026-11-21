const STUBS = { "gpui-kit": "./ui.mjs", "gpui-base": "./ui.mjs", herdr: "./herdr.mjs" };

export async function resolve(specifier, context, next) {
  if (specifier in STUBS) return { url: new URL(STUBS[specifier], import.meta.url).href, shortCircuit: true };
  return next(specifier, context);
}

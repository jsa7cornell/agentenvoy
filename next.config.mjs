/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    instrumentationHook: true,
  },
  // Vercel's @vercel/nft file tracer cannot resolve readFileSync paths when they
  // flow through a wrapper function (runtime-prompts/index.ts load(), formerly
  // playbooks/index.ts pre-2026-05-04 rename). Without this, the .md prompt files
  // are excluded from serverless function bundles and every readFileSync fails
  // at runtime with ENOENT.
  //
  // Include all runtime-prompt .md files for every API route so the tracer bundles them.
  // This was the root cause of the "Something went wrong" failures after PR2
  // (2026-04-28) — the abstraction broke Vercel's static path detection.
  outputFileTracingIncludes: {
    "/api/**/*": [
      "./src/agent/runtime-prompts/**/*.md",
      "./src/lib/negotiator/playbooks/**/*.md",
    ],
  },
};

export default nextConfig;

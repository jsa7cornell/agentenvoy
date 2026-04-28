/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    instrumentationHook: true,
  },
  // Vercel's @vercel/nft file tracer cannot resolve readFileSync paths when they
  // flow through a wrapper function (playbooks/index.ts load()). Without this,
  // the .md playbook files are excluded from serverless function bundles and
  // every readFileSync call fails at runtime with ENOENT.
  //
  // Include all playbook .md files for every API route so the tracer bundles them.
  // This was the root cause of the "Something went wrong" failures after PR2
  // (2026-04-28) — the abstraction broke Vercel's static path detection.
  outputFileTracingIncludes: {
    "/api/**/*": [
      "./src/agent/playbooks/**/*.md",
      "./src/lib/negotiator/playbooks/**/*.md",
    ],
  },
};

export default nextConfig;

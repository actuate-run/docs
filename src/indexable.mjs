// Whether this build may be indexed by search engines: only production, built from the
// production branch. Workers Builds sets WORKERS_CI_BRANCH; production Workers set
// ACTUATE_SITE_ENV=production as a build variable. Anything else (staging, branch
// previews, local builds) gets noindex everywhere.
const env = typeof process === "undefined" ? {} : process.env;
export const indexable = env.ACTUATE_SITE_ENV === "production" && (!env.WORKERS_CI_BRANCH || env.WORKERS_CI_BRANCH === "production");

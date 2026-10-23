CINDERELLA HOME CARE — NETLIFY DEPLOY

This project contains:
- index.html and the website video
- netlify/functions/verify-turnstile.js
- netlify.toml configured to publish the site root and bundle Netlify Functions
- package.json (no third-party runtime dependency required by the function)

IMPORTANT:
Uploading these files through Netlify's manual drag-and-drop static deploy does NOT reliably deploy serverless functions. Deploy this project using a Git-connected Netlify site or Netlify CLI from the project directory so Netlify runs the build and deploys the function.

Required Netlify environment variable:
TURNSTILE_SECRET_KEY (available to Functions/Runtime)

After deployment, verify the function in Netlify > Functions and check:
/.netlify/functions/verify-turnstile

Do not share account passwords. This archive does not change your live Netlify site until you deploy it.


IMPORTANT: ATOMIC RATE LIMITING
The verification function now uses Upstash Redis with an atomic Lua script:
maximum 10 requests per IP per 10-minute window, including concurrent requests.
Create a Redis database in Upstash and add BOTH environment variables in Netlify:
  UPSTASH_REDIS_REST_URL = the database REST URL
  UPSTASH_REDIS_REST_TOKEN = the database REST token
Keep these secret; never put them in index.html or send them in chat.
Keep TURNSTILE_SECRET_KEY configured as before.
If Upstash variables are missing or Redis is unavailable, verification fails closed
with HTTP 503 rather than silently disabling the rate limit.
After publishing, test the function and form on the live site.

const PIXELLAB_BASE_URL = "https://api.pixellab.ai/v2";

export const PIXELLAB_DIRECTIONS = Object.freeze([
  "south",
  "south-west",
  "west",
  "north-west",
  "north",
  "north-east",
  "east",
  "south-east",
]);

export class PixelLabError extends Error {
  constructor(message, { code = "PROVIDER", status = null, details = null } = {}) {
    super(message);
    this.name = "PixelLabError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function errorCodeForStatus(status) {
  if (status === 401) return "AUTH";
  if (status === 402 || status === 403) return "BALANCE";
  if (status === 429 || status === 529) return "RATE_LIMIT";
  if (status === 400 || status === 422) return "INVALID_REFERENCE";
  return "PROVIDER";
}

function detailMessage(payload, fallback) {
  if (typeof payload === "string" && payload.trim()) return payload;
  if (typeof payload?.detail === "string") return payload.detail;
  if (typeof payload?.message === "string") return payload.message;
  if (typeof payload?.error === "string") return payload.error;
  if (Array.isArray(payload?.detail)) {
    return payload.detail
      .map((item) => item?.msg || item?.message || String(item))
      .filter(Boolean)
      .join("; ");
  }
  return fallback;
}

function stripDataUrl(value = "") {
  return value.replace(/^data:image\/[a-z0-9.+-]+;base64,/iu, "");
}

export function createPixelLabClient({
  token,
  fetchImpl = globalThis.fetch,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  baseUrl = PIXELLAB_BASE_URL,
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw new TypeError("PixelLab client requires a fetch implementation");
  }

  async function request(path, { method = "GET", body, responseType = "json" } = {}) {
    if (!token) {
      throw new PixelLabError("PixelLab API token is not configured.", { code: "AUTH" });
    }

    let response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      throw new PixelLabError(`PixelLab network request failed: ${error.message || error}`, {
        code: "NETWORK",
        details: error,
      });
    }

    if (responseType === "buffer" && response.ok) {
      return Buffer.from(await response.arrayBuffer());
    }

    const text = await response.text();
    let payload = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = text;
      }
    }
    if (!response.ok) {
      throw new PixelLabError(
        detailMessage(payload, `PixelLab request failed with status ${response.status}.`),
        {
          code: errorCodeForStatus(response.status),
          status: response.status,
          details: payload,
        },
      );
    }
    return payload;
  }

  return {
    getBalance() {
      return request("/balance");
    },

    createCharacter({ name, description, referenceImage, seed }) {
      return request("/create-character-v3", {
        method: "POST",
        body: {
          description,
          reference_image: {
            type: "base64",
            base64: stripDataUrl(referenceImage),
            format: "png",
          },
          view: "low top-down",
          template_id: "mannequin",
          name,
          seed,
          no_background: true,
        },
      });
    },

    getCharacter(characterId) {
      return request(`/characters/${encodeURIComponent(characterId)}`);
    },

    animateWalk({ characterId, prompt, seed }) {
      return request("/animate-character", {
        method: "POST",
        body: {
          character_id: characterId,
          animation_name: "walk-8dir-4f",
          display_name: "Walk · 8 directions · 4 frames",
          action_description: prompt,
          mode: "v3",
          frame_count: 4,
          keep_first_frame: false,
          directions: PIXELLAB_DIRECTIONS,
          isometric: false,
          seed,
          enhance_prompt: false,
        },
      });
    },

    async pollJob(jobId, { maxAttempts = 72, intervalMs = 5000 } = {}) {
      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        const job = await request(`/background-jobs/${encodeURIComponent(jobId)}`);
        if (job?.status === "completed") return job;
        if (job?.status === "failed") {
          throw new PixelLabError(
            detailMessage(job.last_response, `PixelLab job ${jobId} failed.`),
            { code: "PROVIDER_FAILED", details: job },
          );
        }
        if (attempt < maxAttempts - 1) await sleep(intervalMs);
      }
      throw new PixelLabError(`PixelLab job ${jobId} timed out while still resumable.`, {
        code: "TIMEOUT",
        details: { jobId },
      });
    },

    downloadCharacterZip(characterId) {
      return request(`/characters/${encodeURIComponent(characterId)}/zip`, {
        responseType: "buffer",
      });
    },
  };
}

function unavailable(response) {
  return response.status(503).json({
    code: "PIXELLAB_NOT_CONFIGURED",
    message: "PixelLab v2 is not configured for live character forging.",
  });
}

function sendError(response, error) {
  const status = Number.isInteger(error?.status) && error.status >= 400
    ? error.status
    : 502;
  return response.status(status).json({
    code: error?.code || "FORGE_ERROR",
    message: String(error?.message || error || "Unknown forge error"),
  });
}

export function registerForgeRoutes(app, service) {
  app.get("/api/forge/health", async (_request, response) => {
    try {
      response.json(await service.getHealth());
    } catch (error) {
      sendError(response, error);
    }
  });

  app.post("/api/forge/characters", (request, response) => {
    if (!service.isConfigured) return unavailable(response);
    const job = service.queueCharacter(request.body || {});
    queueMicrotask(() => void service.processJob(job.id));
    return response.status(202).json(job);
  });

  app.get("/api/forge/jobs/:id", (request, response) => {
    const job = service.getJob(request.params.id);
    if (!job) {
      return response.status(404).json({
        code: "FORGE_JOB_NOT_FOUND",
        message: `No forge job exists with id ${request.params.id}.`,
      });
    }
    if (job.status === "resumable") {
      queueMicrotask(() => void service.processJob(job.id));
    }
    return response.json(job);
  });

  app.get("/api/forge/characters/:id", async (request, response) => {
    if (!service.isConfigured) return unavailable(response);
    try {
      return response.json(await service.getCharacter(request.params.id));
    } catch (error) {
      return sendError(response, error);
    }
  });

  app.post("/api/forge/characters/:id/walk", (request, response) => {
    if (!service.isConfigured) return unavailable(response);
    const job = service.queueWalk(request.params.id, request.body || {});
    queueMicrotask(() => void service.processJob(job.id));
    return response.status(202).json(job);
  });

  app.post("/api/forge/characters/:id/source", (request, response) => {
    if (!service.isConfigured) return unavailable(response);
    try {
      return response.json(service.recoverCharacterSource(request.params.id, request.body || {}));
    } catch (error) {
      return sendError(response, error);
    }
  });

  app.get("/api/forge/characters/:id/export", async (request, response) => {
    if (!service.isConfigured) return unavailable(response);
    try {
      const exported = await service.exportCharacter(request.params.id);
      const characterId = String(exported.manifest.characterId).replace(/[^a-z0-9_-]+/giu, "-");
      const runId = String(exported.manifest.runId).replace(/[^a-z0-9_-]+/giu, "-");
      response.setHeader("Content-Type", "application/zip");
      response.setHeader("Content-Disposition", `attachment; filename="${characterId}-${runId}.zip"`);
      return response.send(exported.zipBuffer);
    } catch (error) {
      return sendError(response, error);
    }
  });
}

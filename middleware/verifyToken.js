const verifyToken = async (req, res, next) => {
  try {
    const incomingCookie = req.headers.cookie;
    console.log("[verifyToken] cookie exists:", Boolean(incomingCookie));

    // If no cookie received, return clear error
    if (!incomingCookie) {
      console.warn("[verifyToken] No session cookie received from frontend");
      return res.status(401).json({
        message: "Unauthorized",
        reason: "No session cookie received",
      });
    }

    // Resolve Better Auth URL dynamically from header (case-insensitive), or fallback to environment variables
    const headerFrontendUrl =
      req.headers["x-frontend-url"] ||
      req.headers["X-Frontend-Url"] ||
      req.headers["x-frontend-url".toLowerCase()];
    const betterAuthUrl =
      headerFrontendUrl ||
      process.env.BETTER_AUTH_URL ||
      process.env.FRONTEND_URL ||
      "http://localhost:3000";
    console.log("[verifyToken] BETTER_AUTH_URL used:", betterAuthUrl);
    console.log("[verifyToken] x-frontend-url header received:", headerFrontendUrl || "<none>");

    const response = await fetch(`${betterAuthUrl.replace(/\/$/, "")}/api/auth/get-session`, {
      headers: {
        cookie: incomingCookie,
      },
    });

    console.log("[verifyToken] Better Auth status:", response.status);

    if (!response.ok) {
      const errorText = await response.text();
      console.error("[verifyToken] Better Auth failed:", response.status, errorText);
      return res.status(401).json({
        message: "Unauthorized",
        reason: `Better Auth returned ${response.status}`,
      });
    }

    const session = await response.json();
    console.log("[verifyToken] session user:", session?.user || null);

    if (!session?.user) {
      console.warn("[verifyToken] Better Auth session has no user");
      return res.status(401).json({
        message: "Unauthorized",
        reason: "No user in session",
      });
    }

    req.user = session.user;
    next();
  } catch (err) {
    console.error("[verifyToken] Error:", err.message);
    res.status(500).json({
      message: "Authentication error",
      reason: err.message,
    });
  }
};

module.exports = verifyToken;
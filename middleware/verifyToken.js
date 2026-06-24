const verifyToken = async (req, res, next) => {
  try {
    console.log("Incoming Cookie:", req.headers.cookie);

    const response = await fetch(
      `${process.env.BETTER_AUTH_URL}/api/auth/get-session`,
      {
        headers: {
          cookie: req.headers.cookie || "",
        },
      }
    );

    const session = await response.json();

    console.log("Session:", session);

    if (!session?.user) {
      return res.status(401).send({ message: "Unauthorized" });
    }

    req.user = session.user;
    next();
  } catch (err) {
    console.error("Token verification error:", err);
    res.status(401).send({ message: "Unauthorized" });
  }
};

module.exports = verifyToken;
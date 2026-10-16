using Workerd = import "/workerd/workerd.capnp";

const tlsOptions :Workerd.TlsOptions = (
  keypair = (
    privateKey = embed "privkey.pem",
    certificateChain = embed "fullchain.pem"
  )
);

const config :Workerd.Config = (
  services = [
    (name = "main", worker = .mainWorker),
  ],
  sockets = [
    (
      name = "http",
      address = "*:8787",
      http = (),
      service = "main"
    ),
	(
	  name = "https",
	  address = "*:8788",
	  https = (
	    options = (),
	    tlsOptions = .tlsOptions
	  ),
	  service = "main"
	),
  ]
);

const mainWorker :Workerd.Worker = (
  modules = [
    (
      name = "index.js",
      esModule = embed ".wrangler/dist/index.js"
    ),
  ],
  compatibilityDate = "2025-01-01",
  compatibilityFlags = [
    "nodejs_compat",
  ],
  durableObjectNamespaces = [
    (
      className = "PairingRoom",
      uniqueKey = "cf-ws-server.PairingRoom"
    ),
    (
      className = "ChatRoom",
      uniqueKey = "cf-ws-server.ChatRoom"
    ),
  ],
  bindings = [
    (
      name = "PAIR_ROOM",
      durableObjectNamespace = "PairingRoom"
    ),
    (
      name = "CHAT_ROOM",
      durableObjectNamespace = "ChatRoom"
    ),
    (
      name = "ROOM_KEY_SECRET",
      text = "local-development-secret"
    ),
  ],
  durableObjectStorage = (inMemory = void),
);

// @ts-check
import { createRouter } from "@hattip/router";
import { html, json, text } from "@hattip/response";
import { cookie } from "@hattip/cookie";
import { yoga, createSchema } from "@hattip/graphql";
import { session, EncryptedCookieStore } from "@hattip/session";
import { parseMultipartFormData } from "@hattip/multipart";

const app = createRouter();

app.use(cookie());

app.get("/", (ctx) => {
	return html(
		`<h1>Hello from Hattip!</h1><p>URL: <span>${ctx.request.url}</span></p><p>Your IP address is: <span>${ctx.ip}</span></p>`,
	);
});

app.get(
	"/binary",
	() =>
		new Response(
			new TextEncoder().encode(
				"This is rendered as binary with non-ASCII chars 😊",
			),
			{ headers: { "Content-Type": "text/plain; charset=utf-8" } },
		),
);

app.get("/bin-stream", (context) => {
	const delay = Number(context.url.searchParams.get("delay")) || 0;

	const output = new TextEncoder().encode(
		"This is rendered as binary stream with non-ASCII chars 😊",
	);

	let i = 0;

	const { readable, writable } = new TransformStream();

	async function stream() {
		const writer = writable.getWriter();

		for (let i = 0; i < output.length; i++) {
			await new Promise((resolve) => {
				setTimeout(resolve, delay);
			});
			writer.write(new Uint8Array([output[i]]));
		}

		writer.close();
	}

	context.waitUntil(stream());

	return new Response(readable, {
		headers: { "Content-Type": "text/plain; charset=utf-8" },
	});
});

app.post("/echo-text", async (ctx) => text(await ctx.request.text()));

app.post(
	"/echo-bin",
	async (ctx) =>
		new Response(new Uint8Array(await ctx.request.arrayBuffer()).join(", ")),
);

app.get("/cookie", (ctx) => {
	return json(ctx.cookie);
});

app.get("/set-cookie", (ctx) => {
	ctx.setCookie("name1", "value1");
	ctx.setCookie("name2", "value2");

	return text("Cookies set");
});

app.get("/status", () => new Response(null, { status: 403 }));

app.get("/headers", (ctx) => {
	const headers = Object.fromEntries(ctx.request.headers.entries());
	return json(headers);
});

app.get("/query", (ctx) => {
	return json(ctx.url.searchParams.get("foo"));
});

app.get("/pass", () => text("Passed on from an edge middleware"));

/** @type {import("@hattip/graphql").GraphQLSchemaWithContext<{ requestContext: import("@hattip/compose").RequestContext}>} */
const schema = createSchema({
	typeDefs: `type Query {
		hello: String!
		context: String
		sum(a: Int!, b: Int!): Int!
	}`,
	resolvers: {
		Query: {
			hello: () => "Hello world!",
			context: (_root, _args, ctx) =>
				ctx.requestContext.request.headers.get("x-test"),
			sum: (_root, args) => args.a + args.b,
		},
	},
});

app.use(
	"/graphql",
	yoga({
		graphqlEndpoint: "/graphql",

		graphiql: {
			defaultQuery: `query { hello }`,
		},

		// TODO: Understand why this is needed
		// @ts-expect-error
		schema,
	}),
);

/**
 * @type {(ctx: import("@hattip/compose").RequestContext) => Promise<Response>}
 */
let sessionMiddleware;

// This is so complicated because top level await is not supported on Node 14
app.use("/session", async (ctx) => {
	sessionMiddleware =
		sessionMiddleware ??
		session({
			store: new EncryptedCookieStore(
				await EncryptedCookieStore.generateKeysFromBase64([
					"cnNwJHcQHlHHB7+/zRYOJP/m0JEXxQpoGskCs8Eg+XI=",
				]),
			),
			defaultSessionData: { count: 0 },
		});

	return sessionMiddleware(ctx);
});

app.get("/session", (ctx) => {
	// @ts-ignore
	ctx.session.data.count++;
	// @ts-ignore
	return text(`You have visited this page ${ctx.session.data.count} time(s).`);
});

/** @type {(stream: ReadableStream<Uint8Array>) => Promise<Uint8Array>} */
async function readAll(stream) {
	const reader = stream.getReader();
	/** @type {Uint8Array[]} */
	const chunks = [];
	let totalLength = 0;

	while (true) {
		const { done, value } = await reader.read();
		if (done) {
			break;
		}
		chunks.push(value);
		totalLength += value.length;
	}

	const result = new Uint8Array(totalLength);
	let offset = 0;
	for (const chunk of chunks) {
		result.set(chunk, offset);
		offset += chunk.length;
	}

	return result;
}

/** @type {(data: ArrayBuffer) => string} */
function toBase64(data) {
	if (typeof Buffer !== "undefined") {
		return Buffer.from(data).toString("base64");
	}

	return btoa(String.fromCharCode(...new Uint8Array(data)));
}

app.post("/form", async (ctx) => {
	const fd = await parseMultipartFormData(ctx.request, {
		handleFile: async (fileInfo) => ({
			...fileInfo,
			body: toBase64(await readAll(fileInfo.body)),
		}),
		createTypeError: () => text("Unsupported media type", { status: 415 }),
		createContentDispositionError: () =>
			text("Invalid content disposition", { status: 400 }),
		createLimitError: (name, value, limit) =>
			text(`Field ${name} is too long (max ${limit} bytes)`, { status: 400 }),
	});

	return json(Object.fromEntries(fd));
});

app.get("/platform", (ctx) => {
	// @ts-expect-error
	return text(`Platform: ${ctx.platform.name}`);
});

export default app.buildHandler();

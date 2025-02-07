import { base } from "$app/paths";
import { authCondition, requiresUser } from "$lib/server/auth";
import { collections } from "$lib/server/database";
import { fail, type Actions, redirect } from "@sveltejs/kit";
import { ObjectId } from "mongodb";

import { z } from "zod";
import sizeof from "image-size";
import { sha256 } from "$lib/utils/sha256";

const newAsssistantSchema = z.object({
	name: z.string().min(1),
	modelId: z.string().min(1),
	preprompt: z.string().min(1),
	description: z.string().optional(),
	exampleInput1: z.string().optional(),
	exampleInput2: z.string().optional(),
	exampleInput3: z.string().optional(),
	exampleInput4: z.string().optional(),
	avatar: z.instanceof(File).optional(),
});

const uploadAvatar = async (avatar: File, assistantId: ObjectId): Promise<string> => {
	const hash = await sha256(await avatar.text());
	const upload = collections.bucket.openUploadStream(`${assistantId.toString()}`, {
		metadata: { type: avatar.type, hash },
	});

	upload.write((await avatar.arrayBuffer()) as unknown as Buffer);
	upload.end();

	// only return the filename when upload throws a finish event or a 10s time out occurs
	return new Promise((resolve, reject) => {
		upload.once("finish", () => resolve(hash));
		upload.once("error", reject);
		setTimeout(() => reject(new Error("Upload timed out")), 10000);
	});
};

export const actions: Actions = {
	default: async ({ request, locals }) => {
		const formData = Object.fromEntries(await request.formData());

		const parse = newAsssistantSchema.safeParse(formData);

		if (!parse.success) {
			// Loop through the errors array and create a custom errors array
			const errors = parse.error.errors.map((error) => {
				return {
					field: error.path[0],
					message: error.message,
				};
			});

			return fail(400, { error: true, errors });
		}

		// can only create assistants when logged in, IF login is setup
		if (!locals.user && requiresUser) {
			const errors = [{ field: "preprompt", message: "Must be logged in. Unauthorized" }];
			return fail(400, { error: true, errors });
		}

		const createdById = locals.user?._id ?? locals.sessionId;

		const newAssistantId = new ObjectId();

		const exampleInputs: string[] = [
			parse?.data?.exampleInput1 ?? "",
			parse?.data?.exampleInput2 ?? "",
			parse?.data?.exampleInput3 ?? "",
			parse?.data?.exampleInput4 ?? "",
		].filter((input) => !!input);

		let hash;
		if (parse.data.avatar && parse.data.avatar.size > 0) {
			const dims = sizeof(Buffer.from(await parse.data.avatar.arrayBuffer()));

			if ((dims.height ?? 1000) > 512 || (dims.width ?? 1000) > 512) {
				const errors = [
					{
						field: "avatar",
						message:
							"Avatar is too big. Please make sure the size of your avatar is no bigger than 512px by 512px.",
					},
				];
				return fail(400, { error: true, errors });
			}

			hash = await uploadAvatar(parse.data.avatar, newAssistantId);
		}

		const { insertedId } = await collections.assistants.insertOne({
			_id: newAssistantId,
			createdById,
			createdByName: locals.user?.username ?? locals.user?.name,
			...parse.data,
			exampleInputs,
			avatar: hash,
			createdAt: new Date(),
			updatedAt: new Date(),
			userCount: 1,
		});

		// add insertedId to user settings

		await collections.settings.updateOne(authCondition(locals), {
			$addToSet: { assistants: insertedId },
		});

		throw redirect(302, `${base}/settings/assistants/${insertedId}`);
	},
};

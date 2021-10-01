/**
 * See https://bugzilla.mozilla.org/show_bug.cgi?id=1732258
 * 
 * TODO:
 *  - check for new templates released for older TB versions
 * 
 */

// Debug logging (0 - errors and basic logs only, 1 - verbose debug)
const debugLevel = 0;

const build_dir = "./build";
const state_dir = "./data/gitstate";
const schema_dir = "./data/schema";
const mozilla_template_dir = "./data/mozilla-policy-templates";

const readme_json_path = "./readme_#tree#.json";
const compatibility_json_path = `${build_dir}/compatibility.json`;
const revisions_json_write_path = "./revisions.json";
const revisions_json_read_path = `${state_dir}/enterprise-policy-generator/script/revisions.json`;

// replacement for deprecated request
const bent = require('bent');
const bentGetTEXT = bent('GET', 'string', 200);

const cheerio = require('cheerio');
const git = require("isomorphic-git");
const http = require('isomorphic-git/http/node');
const xml2js = require('xml2js');
const util = require('util');
const fs = require('fs-extra');
const path = require("path");

const {
	parse,
	stringify,
	assign
} = require('comment-json');

var gCompatibilityData = {};

const gTemplate = `## Enterprise policy descriptions and templates for __name__

__desc__

| Policy Name | Description
|:--- |:--- |
__list_of_policies__

__details__

`;

function debug(...args) {
	if (debugLevel > 0) {
		console.debug(...args);
	}
}

function dump(data) {
	console.log(util.inspect(data, false, null));
}

/**
 * bent based request variant with hard timeout on client side.
 * 
 * @param {string} url - url to GET
 * @returns - text content
 */
async function request(url) {
	debug(" -> ", url);
	// Retry on error, using a hard timeout enforced from the client side.
	let rv;
	for (let i = 0; (!rv && i < 5); i++) {
		if (i > 0) {
			console.error("Retry", i);
			await new Promise(resolve => setTimeout(resolve, 5000));
		}

		let killTimer;
		let killSwitch = new Promise((resolve, reject) => { killTimer = setTimeout(reject, 15000, "HardTimeout"); })
		rv = await Promise
			.race([bentGetTEXT(url), killSwitch])
			.catch(err => {
				console.error('Error in  request', err);
				return null;
			});

		// node will continue to "wait" after the script finished, if we do not
		// clear the timeouts.
		clearTimeout(killTimer);
	}
	return rv;
}

/**
 * Escape illegal chars from markdown code.
 * 
 * @param {string} str - markdown code string
 * @returns - escaped string
 */
function escape_code_markdown(str) {
	let chars = [
		"\\|",
	];
	for (let char of chars) {
		str = str.replace(new RegExp(char, 'g'), char);
	}
	return str;
}

/**
 * Rebrand from Firefox to Thunderbird.
 * 
 * @param {*} lines - string or array of strings which need to be rebranded.
 * @returns - rebranded string (input array is joined by \n)
 */
function rebrand(lines) {
	if (!Array.isArray(lines))
		lines = [lines.toString()];

	const replacements = [
		{
			reg: /\bFirefox\b/g,
			val: "Thunderbird",
		},
		{
			reg: /\bfirefox\b/g,
			val: "thunderbird",
		},
		{
			reg: /([\W_])FF(\d\d)/g,
			val: "\$1TB\$2",
		},
		{
			reg: /\bAMO\b/g,
			val: "ATN",
		},
		{
			reg: /addons.mozilla.org/g,
			val: "addons.thunderbird.net",
		},
		{	// Undo a wrong replace
			reg: "https://support.mozilla.org/kb/setting-certificate-authorities-thunderbird",
			val: "https://support.mozilla.org/kb/setting-certificate-authorities-firefox"
		},
		{	// Undo a wrong replace
			reg: "https://support.mozilla.org/en-US/kb/dom-events-changes-introduced-thunderbird-66",
			val: "https://support.mozilla.org/en-US/kb/dom-events-changes-introduced-firefox-66"
		}
	]

	for (let i = 0; i < lines.length; i++) {
		for (let r of replacements) {
			lines[i] = lines[i].replace(r.reg, r.val);
		}
	}

	return lines.join("\n");
}

// -----------------------------------------------------------------------------

/**
 * Clone or pull a github repository.
 * 
 * @param {string} url - url to the repository
 * @param {string} ref - branch/tag to checkout, "master" or "v3.0"
 * @param {string} dir - directory to store templates in
 * 
 */
async function pullGitRepository(url, ref, dir) {
	if (!fs.existsSync(dir)) {
		console.log(`Cloning ${url} (${ref})`);
		fs.ensureDirSync(dir);
		await git.clone({
			fs,
			http,
			dir,
			url,
			ref,
			singleBranch: true,
			depth: 10,
			force: true
		});
	} else {
		console.log(`Updating ${url} (${ref})`);
		await git.pull({
			author: { name: "generate_policy_template.js" },
			fs,
			http,
			dir,
			ref,
			singleBranch: true,
			force: true
		});
	}
}

/**
 * Parse the README file of a given mozilla policy template.
 * 
 * @param {string} tree - "central" or "esr91"
 * 
 * @return - parsed data from readme.json, updated with upstream changes
 */
async function parseMozillaPolicyReadme(tree) {
	// Load last known version of the headers and policy chunks of the readme.
	let readme_file_name = readme_json_path.replace("#tree#", tree);
	let readmeData = fs.existsSync(readme_file_name)
		? parse(fs.readFileSync(readme_file_name).toString())
		: {};

	if (!readmeData) readmeData = {};
	if (!readmeData.headers) readmeData.headers = {};
	if (!readmeData.policies) readmeData.policies = {};

	let ref = readmeData.mozillaReferenceTemplates;
	let dir = `${mozilla_template_dir}/${ref}`;
	await pullGitRepository("https://github.com/mozilla/policy-templates/", ref, dir);

	// This parsing highly depends on the structure of the README and needs to be
	// adjusted when its layout is changing. In the intro section we have lines like 
	// | **[`3rdparty`](#3rdparty)** |
	// Detailed descriptions are below level 3 headings (###) with potential subsections.

	// Split on ### heading to get chunks of policy descriptions.
	let file = fs.readFileSync(`${dir}/README.md`, 'utf8');
	let data = file.split("\n### ");

	// Shift out the header and process it.
	for (let h of data.shift().split("\n").filter(e => e.startsWith("| **[`"))) {
		let name = h
			.match(/\*\*\[(.*?)\]/)[1] // extract name from the markdown link
			.replace(/`/g, "") // unable to fix the regex to exclude those
			.replace(" -> ", "_"); // flat hierarchy

		if (!readmeData.headers[name]) {
			readmeData.headers[name] = { upstream: h };
		} else if (!readmeData.headers[name].upstream || readmeData.headers[name].upstream != h) {
			readmeData.headers[name].upstream = h;
		}
	}

	// Process policies.
	for (let p of data) {
		let lines = p.split("\n");
		let name = lines[0];
		lines[0] = `## ${name}`;

		name = name.replace(" | ", "_"); // flat hierarchy
		if (!readmeData.policies[name]) {
			readmeData.policies[name] = { upstream: lines };
		} else if (!readmeData.policies[name].upstream || stringify(readmeData.policies[name].upstream) != stringify(lines)) {
			readmeData.policies[name].upstream = lines;
		}
	}

	fs.writeFileSync(readme_file_name, stringify(readmeData, null, 2));
	return readmeData;
}

function getPolicySchemaFilename(branch, tree, ref) {
	return `${schema_dir}/${branch}-${tree}-${ref}.json`;
}

/**
 * Download missing revisions of the policies-schema.json for the given tree.
 * 
 * @params {string} tree - "central" or "esr91"
 * 
 * Returns a data object for comm and mozilla.
 */
async function downloadPolicySchemaFiles(tree) {
	let data = {
		comm: {
			hgLogUrl: "",
			revisions: []
		},
		mozilla: {
			hgLogUrl: "",
			revisions: []
		},
	};

	console.log(`Processing ${tree}`);
	fs.ensureDirSync(schema_dir);

	// For mozilla, we just need to check if there is a new revision out.
	// For comm, we need all revisions
	for (let branch of ["mozilla", "comm"]) {
		let folder = branch == "mozilla" ? "browser" : "mail"
		let path = tree == "central" ? `${branch}-${tree}` : `releases/${branch}-${tree}`
		let max = branch == "mozilla" ? 5 : 30;

		console.log(`Checking policies-schema.json revisions for ${path}`);
		data[branch].hgLogUrl = `https://hg.mozilla.org/${path}/log/tip/${folder}/components/enterprisepolicies/schemas/policies-schema.json`;
		let hgLog = await request(data[branch].hgLogUrl);
		const $ = cheerio.load(hgLog);

		// Get the revision identifier from the table cell (TODO: switch to github tree instead of parsing html)
		let revisions = [...$("body > table > tbody > tr > td:nth-child(2)")].map(element => element.children[0].data.trim());

		for (let revision of revisions.slice(0, max)) {
			let filename = getPolicySchemaFilename(branch, tree, revision);
			let file;
			let version;
			if (!fs.existsSync(filename)) {
				let url = `https://hg.mozilla.org/${path}/raw-file/${revision}/${folder}/components/enterprisepolicies/schemas/policies-schema.json`
				console.log(`Downloading ${url}`);
				file = parse(await request(url));
				version = (await request(`https://hg.mozilla.org/${path}/raw-file/${revision}/${folder}/config/version.txt`)).trim();
				file.version = version;
				file.revision = revision;
				fs.writeFileSync(getPolicySchemaFilename(branch, tree, revision), stringify(file, null, 2));
			} else {
				file = parse(fs.readFileSync(filename).toString());

			}
			data[branch].revisions.push(file);
		}
	}
	return data;
}

/**
 * Extract flat policy named from a schema file
 * 
 * @param {object} data - Object returned by downloadPolicySchemaFiles
 */
function extractFlatPolicyNamesFromPolicySchema(data) {
	let properties = [];
	for (let key of ["properties", "patternProperties"]) {
		if (data[key]) {
			for (let [name, entry] of Object.entries(data[key])) {
				properties.push(name)
				let subs = extractFlatPolicyNamesFromPolicySchema(entry);
				if (subs.length > 0) properties.push(...subs.map(e => `${name}_${e}`))
			}
		}
	}
	return properties;
}

/**
* Check for changes in the policy schema files between two revisions.
* 
* @param {object} data - Object returned by downloadPolicySchemaFiles
*/
function checkPolicySchemaChanges(file1, file2) {
	if (!file1?.properties || !file2?.properties)
		return;

	let keys1 = extractFlatPolicyNamesFromPolicySchema(file1);
	let keys2 = extractFlatPolicyNamesFromPolicySchema(file2);

	let added = keys2.filter(e => !keys1.includes(e));
	let removed = keys1.filter(e => !keys2.includes(e));

	let changed = keys2.filter(e => keys1.includes(e) && JSON.stringify(file2.properties[e]) != JSON.stringify(file1.properties[e]));

	return { added, removed, changed }
}

// -----------------------------------------------------------------------------

/**
 * Generate the compatibility table.
 * 
 * @param {*} policy 
 * @param {*} tree 
 * @returns 
 */
function buildCompatibilityTable(policy, tree) {
	let details = [];

	// Get all entries found in gCompatibilityData which are related to policy.
	let entries = Object.keys(gCompatibilityData).filter(k => k == policy || k.startsWith(policy + "_"));

	// Group filtered entries by identical compat data.
	let distinct = [];
	for (let entry of entries) {
		// Generate the compatibility information, which will be used as key. Primary
		// information is the one from this tree, but if it was backported to one version
		// prior (92.0a1 -> 91.0) only list the backported one.
		let added = gCompatibilityData[entry][tree].replace(".0a1", ".0");
		let added_parts = added.split(".");
		let backported = Object.keys(gCompatibilityData[entry])
			.filter(e => e != tree)
			.filter(e => gCompatibilityData[entry][e] != gCompatibilityData[entry][tree])
			.map(e => gCompatibilityData[entry][e])
			.pop();

		if (backported
			&& added_parts.length == 2
			&& added_parts[1] == "0"
			&& `${parseInt(added_parts[0], 10) - 1}.0` == backported
		) {
			key = `Thunderbird ${backported}`;
		} else if (backported) {
			key = `Thunderbird ${added}, Thunderbird ${backported}`;
		} else {
			key = `Thunderbird ${added}`;
		}

		let distinctEntry = distinct.find(e => e.key == key);
		let humanReadableEntry = "`" + escape_code_markdown(entry
			.replace("^.*$", "[name]")
			.replace("^(", "(")
			.replace(")$", ")")) + "`";

		if (!distinctEntry) {
			distinct.push({
				key,
				policies: [humanReadableEntry],
			})
		} else {
			distinctEntry.policies.push(humanReadableEntry);
		}
	}
	// Build compatibility chart.
	if (distinct.length > 0) {
		details.push("#### Compatibility", "", "| Policy/Property Name | Compatibility Information |", "|:--- |:--- |");
		for (let distinctEntry of distinct) {
			details.push(`| ${distinctEntry.policies.join("<br>")} | ${distinctEntry.key} |`);
		}
	}
	return details;
}

/**
 * Build the ADMX/ADML files.
 */
async function buildAdmxFiles(template, thunderbirdPolicies, output_dir) {
	// Read ADMX files - https://www.npmjs.com/package/xml2js
	var parser = new xml2js.Parser();
	let admx_file = fs.readFileSync(`${mozilla_template_dir}/${template.mozillaReferenceTemplates}/windows/firefox.admx`);
	let admx_obj = await parser.parseStringPromise(
		rebrand(admx_file).replace(/">">/g, '">'), // issue https://github.com/mozilla/policy-templates/issues/801
	);

	function getNameFromKey(key) {
		const key_prefix = "Software\\Policies\\Mozilla\\Thunderbird\\";
		const key_prefix_length = key_prefix.length;
		if (key.length > key_prefix_length) {
			return key.substring(key_prefix_length).split("\\").join("_");
		}
	}
	function isThunderbirdPolicy(policy, element) {
		let parts = [];
		let name = getNameFromKey(policy.$.key);
		if (name) {
			parts.push(name);
		}

		if (policy.$.valueName) {
			parts.push(policy.$.valueName);
		}

		if (element) {
			if (element.$.key) parts = [getNameFromKey(element.$.key)];
			else if (element.$.valueName) parts.push(element.$.valueName);
		}

		return thunderbirdPolicies.includes(parts.join("_"));
	}

	// Remove unsupported policies. (Remember, we work with flattened policy_property names here)
	// A single admx policy entry can include multiple elements, we need to check those individually.
	let admxPolicies = admx_obj.policyDefinitions.policies[0].policy;
	for (let policy of admxPolicies) {
		if (!isThunderbirdPolicy(policy)) {
			policy.unsupported = true
		}

		if (policy.elements) {
			for (let element of policy.elements) {
				for (let type of Object.keys(element)) {
					element[type] = element[type].filter(e => isThunderbirdPolicy(policy, e))
					if (element[type].length == 0) delete element[type]
					else delete policy.unsupported;
				}
			}
			// If we removed all elements, remove the policy
			policy.elements = policy.elements.filter(e => Object.keys(e).length > 0)
			if (policy.elements.length == 0) policy.unsupported = true
		}
	}
	admx_obj.policyDefinitions.policies[0].policy = admxPolicies.filter(p => !p.unsupported);

	// Rebuild thunderbird.admx file.
	var builder = new xml2js.Builder();
	var xml = builder.buildObject(admx_obj);
	fs.ensureDirSync(`${output_dir}/windows`);
	fs.writeFileSync(`${output_dir}/windows/thunderbird.admx`, xml);

	// Copy mozilla.admx file.
	file = fs.readFileSync(`${mozilla_template_dir}/${template.mozillaReferenceTemplates}/windows/mozilla.admx`);
	fs.writeFileSync(`${output_dir}/windows/mozilla.admx`, file);

	// Handle translation files.
	let folders = fs.readdirSync(`${mozilla_template_dir}/${template.mozillaReferenceTemplates}/windows`, { withFileTypes: true })
		.filter(dirent => dirent.isDirectory())
		.map(dirent => dirent.name);
	for (let folder of folders) {
		fs.ensureDirSync(`${output_dir}/windows/${folder}`);
		let file = fs.readFileSync(`${mozilla_template_dir}/${template.mozillaReferenceTemplates}/windows/${folder}/firefox.adml`);
		fs.writeFileSync(`${output_dir}/windows/${folder}/thunderbird.adml`, rebrand(file));
		// This file probably does not need to change
		file = fs.readFileSync(`${mozilla_template_dir}/${template.mozillaReferenceTemplates}/windows/${folder}/mozilla.adml`);
		fs.writeFileSync(`${output_dir}/windows/${folder}/mozilla.adml`, file);
	}
}

/**
 * Build the README file.
 */
async function buildReadme(tree, template, thunderbirdPolicies, output_dir) {
	 let header = [];
	 let details = [];
	 let printed_main_policies = [];
	 let skipped_main_policies = [];
	 // Loop over all policies found in the thunderbird policy schema file and rebuild the readme.
	 for (let policy of thunderbirdPolicies) {
		 // Get the policy header from the template (or its override).
		 if (template.headers[policy]) {
			 let content = template.headers[policy].override || template.headers[policy].upstream;
			 if (content && content != "skip") {
				 header.push(content);
			}
			printed_main_policies.push(policy.split("_").shift());
		} else {
			 // Keep track of policies which are not mentioned directly in the readme.
			 let skipped = policy.split("_").shift();
			 if (!skipped_main_policies.includes(skipped)) skipped_main_policies.push(skipped);
		 }
 
		 // Get the policy details from the template (or its override).
		 if (template.policies[policy]) {
			 let content = template.policies[policy].override || template.policies[policy].upstream;
			 if (content && content != "skip") {
				 details.push(...content.filter(e => !e.includes("**Compatibility:**")));
				 details.push(...buildCompatibilityTable(policy, tree));
				 details.push("", "<br>", "");
			 }
		 }
	 }
 
	 for (let skipped of skipped_main_policies) {
		if (!printed_main_policies.includes(skipped)) {
			console.error(`  --> WARNING: Supported policy not present in readme: ${skipped}\n`);
		}
	 }

	 let md = gTemplate
		 .replace("__name__", template.name)
		 .replace("__desc__", template.desc.join("\n"))
		 .replace("__list_of_policies__", rebrand(header))
		 .replace("__details__", rebrand(details));
 
	 fs.ensureDirSync(output_dir);
	 fs.writeFileSync(`${output_dir}/README.md`, md); 
}

/**
 * Generate the Thunderbird templates.
 * 
 * @param {*} settings 
 *  settings.tree - 
 *  settings.mozillaReferencePolicyRevision -
 * @returns 
 */
async function buildThunderbirdTemplates(settings) {
	// Download schema from https://hg.mozilla.org/
	let data = await downloadPolicySchemaFiles(settings.tree);
	if (!data)
		return;

	let output_dir = `${build_dir}/${settings.tree}`;
	let mozillaReferencePolicyFile = data.mozilla.revisions.find(r => r.revision == settings.mozillaReferencePolicyRevision);
	if (!mozillaReferencePolicyFile) {
		console.error(`Unknown policy revision ${settings.mozillaReferencePolicyRevision} set for mozilla-${settings.tree}.\nCheck ${data.mozilla.hgLogUrl}`);
		return;
	}

	// Get changes in the schema files and log them.
	if (mozillaReferencePolicyFile.revision != data.mozilla.revisions[0].revision) {
		settings.mozillaReferencePolicyRevision = data.mozilla.revisions[0].revision;
		let m_m_changes = checkPolicySchemaChanges(mozillaReferencePolicyFile, data.mozilla.revisions[0]);
		if (m_m_changes) {
			console.log();
			console.log(` Mozilla has released an new policy revision for mozilla-${settings.tree}!`);
			console.log(` Do those changes need to be ported to Thunderbird?`);
			if (m_m_changes.added.length > 0) console.log(` - Mozilla added the following policies:`, m_m_changes.added);
			if (m_m_changes.removed.length > 0) console.log(` - Mozilla removed the following policies:`, m_m_changes.removed);
			if (m_m_changes.changed.length > 0) console.log(` - Mozilla changed properties of the following policies:`, m_m_changes.changed);
			console.log();
			console.log(` - currently acknowledged policy revision (${mozillaReferencePolicyFile.revision} / ${mozillaReferencePolicyFile.version}): \n\t${path.resolve(getPolicySchemaFilename("mozilla", settings.tree, mozillaReferencePolicyFile.revision))}\n`);
			console.log(` - latest available policy revision (${data.mozilla.revisions[0].revision} / ${data.mozilla.revisions[0].version}): \n\t${path.resolve(getPolicySchemaFilename("mozilla", settings.tree, data.mozilla.revisions[0].revision))}\n`);
			console.log(` - hg change log for mozilla-${settings.tree}: \n\t${data.mozilla.hgLogUrl}\n`);
			console.log(` If those changes are not needed for Thunderbird, check-in the updated ${revisions_json_write_path} file to acknowledge the change. Otherwise port the changes first.\n`);
		}
	}

	/*	TODO: For the readme it would be helpful to know which properties of used policies are not supported
		// This logs differences between m-c and c-c, but the gain of information is not much, clutters the screen, we know they differ.
		let m_c_diff = checkPolicySchemaChanges(data.mozilla.currentFile, data.comm.currentFile);
		if (m_c_diff) {
			console.log();
			console.log(` There are differences between the currently acknowledged policy revisions of Mozilla and Thunderbird for the ${settings.tree} branch!`);
			if (m_c_diff.added.length > 0) console.log(` - Thunderbird added extra support for the following policies in the currently acknowledged policy revisions:`, m_c_diff.added);
			if (m_c_diff.removed.length > 0) console.log(` - Thunderbird does not support the following policies in the currently acknowledged policy revisions:`, m_c_diff.removed);
			if (m_c_diff.changed.length > 0) console.log(` - Thunderbird and Mozilla policy properties differ in the following policies in the currently acknowledged policy revisions:`, m_c_diff.changed);
			console.log();
			console.log(` - currently acknowledged mozilla policy revision (${data.mozilla.currentRevision}): \n\t${path.resolve(getPolicySchemaFilename("mozilla", settings.tree, data.mozilla.currentRevision))}\n`);
			console.log(` - currently acknowledged comm policy revision (${data.comm.currentRevision}): \n\t${path.resolve(getPolicySchemaFilename("comm", settings.tree, data.comm.currentRevision))}\n`);
			console.log(` - available template versions: \n\thttps://github.com/mozilla/policy-templates/releases\n`);
		}
	*/

	/**
	 * Extract compatibility information.
	 */
	for (let r = data.comm.revisions.length; r > 0; r--) {
		let policies = extractFlatPolicyNamesFromPolicySchema(data.comm.revisions[r - 1]);
		for (let raw_policy of policies) {
			let policy = raw_policy.trim().replace(/'/g,"");
			if (!gCompatibilityData[policy]) {
				gCompatibilityData[policy] = {};
			}
			if (!gCompatibilityData[policy][settings.tree]) {
				gCompatibilityData[policy][settings.tree] = data.comm.revisions[r - 1].version;
			}
		}
	}

	let template = await parseMozillaPolicyReadme(settings.tree);
	let thunderbirdPolicies = Object.keys(gCompatibilityData).sort(function (a, b) {
		return a.toLowerCase().localeCompare(b.toLowerCase());
	});

	await buildReadme(settings.tree, template, thunderbirdPolicies, output_dir);
	await buildAdmxFiles(template, thunderbirdPolicies, output_dir);
	// TODO: Mac
}

async function main() {
	// Checkout the current state of the repo, so we can see if new revisions found have been acked already. 
	await pullGitRepository("https://github.com/thundernest/thundernest.github.io", "main", state_dir);

	// Load revision data (to see if any new revisions have been added to the tree).
	let revisionData = fs.existsSync(revisions_json_read_path)
		? parse(fs.readFileSync(revisions_json_read_path).toString())
		: [
			{ // A starter set, if the revision config file is missing.
				tree: "esr68",
				mozillaReferencePolicyRevision: "1b0a29b456b432d1c8bef09c233b84205ec9e13c",
			},
			{
				tree: "esr78",
				mozillaReferencePolicyRevision: "a8c4670b6ef144a0f3b6851c2a9d4bbd44fc032a",
			},
			{
				tree: "esr91",
				mozillaReferencePolicyRevision: "02bf5ca05376f55029da3645bdc6c8806e306e80",

			},
			{
				tree: "central",
				mozillaReferencePolicyRevision: "02bf5ca05376f55029da3645bdc6c8806e306e80",
			}
		];

	for (let revision of revisionData) {
		await buildThunderbirdTemplates(revision);
	}

	// Update config files.
	fs.writeFileSync(compatibility_json_path, stringify(gCompatibilityData, null, 2));
	fs.writeFileSync(revisions_json_write_path, stringify(revisionData, null, 2));
}

main();

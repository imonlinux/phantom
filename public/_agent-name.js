// Canonical agent-name customization IIFE for Phantom static pages.
//
// Loaded once per page with <script src="/ui/_agent-name.js"></script>.
// Replaces [data-agent-name], [data-agent-name-initial], [data-agent-name-lower]
// nodes with the deployed agent name and substitutes {{AGENT_NAME_CAPITALIZED}}
// in any <title data-agent-name-title> template.
//
// Mirrors the server-side capitalizeAgentName contract: empty/whitespace name
// falls back to "Phantom" so the brand never reads as blank. Paints an
// optimistic value from localStorage (or "Phantom") on load, then swaps when
// /health resolves so warm loads have no flash and cold loads see "Phantom"
// instead of a stray &nbsp; until the fetch resolves.
(function () {
	function cap(name) {
		if (!name) return "Phantom";
		var trimmed = String(name).trim();
		if (!trimmed) return "Phantom";
		return trimmed
			.split(/([-_])/)
			.map(function (part) {
				if (part === "-" || part === "_") return part;
				if (!part.length) return part;
				return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
			})
			.join("");
	}

	var titleEl = document.querySelector("title[data-agent-name-title]");
	var titleTemplate = titleEl ? titleEl.getAttribute("data-agent-name-title-template") : "";
	if (titleEl && !titleTemplate) {
		var initial = titleEl.textContent || "";
		if (initial.indexOf("{{AGENT_NAME_CAPITALIZED}}") !== -1) {
			titleTemplate = initial;
			titleEl.setAttribute("data-agent-name-title-template", initial);
		}
	}

	function apply(name) {
		var display = cap(name);
		var initial = display.charAt(0).toUpperCase();
		var lower = display.toLowerCase();
		document.querySelectorAll("[data-agent-name]").forEach(function (el) {
			el.textContent = display;
		});
		document.querySelectorAll("[data-agent-name-initial]").forEach(function (el) {
			el.textContent = initial;
		});
		document.querySelectorAll("[data-agent-name-lower]").forEach(function (el) {
			el.textContent = lower;
		});
		if (titleEl && titleTemplate) {
			titleEl.textContent = titleTemplate.split("{{AGENT_NAME_CAPITALIZED}}").join(display);
		}
		try {
			if (name) {
				localStorage.setItem("phantom-agent-name", name);
			}
		} catch (e) {}
	}

	var cached = "";
	try {
		cached = localStorage.getItem("phantom-agent-name") || "";
	} catch (e) {}
	apply(cached || "Phantom");

	fetch("/health", { credentials: "same-origin" })
		.then(function (r) {
			return r.ok ? r.json() : null;
		})
		.then(function (d) {
			if (d && d.agent) apply(d.agent);
		})
		.catch(function () {});
})();

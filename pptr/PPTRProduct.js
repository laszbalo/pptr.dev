class PPTRProduct extends App.Product {
  static async create() {
    const [releasesText, readmeText] = await Promise.all([
      // Do not fetch too often to avoid GitHub API rate limiting: https://developer.github.com/v3/#rate-limiting
      fetchCached('https://api.github.com/repos/GoogleChrome/puppeteer/releases', 'pptr-releases', 1000 * 60 * 5 /* 5 minutes */),
      fetchCached('https://raw.githubusercontent.com/GoogleChrome/puppeteer/master/README.md', 'pptr-readme', 1000 * 60 * 60 * 24 /* 1 day */),
    ]);
    const releases = JSON.parse(releasesText).map(release => ({
      name: release.tag_name,
      releaseNotes: release.body,
    }));
    releases.unshift({name: 'master'});
    // The very first release had no notes.
    releases.push({
      name: 'v0.9.0',
      releaseNotes: '',
    });

    const apiTexts = await Promise.all(releases.map(release => fetchAPI(release.name)));
    for (let i = 0; i < apiTexts.length; ++i)
      releases[i].apiText = apiTexts[i];
    return new PPTRProduct(readmeText, releases);

    async function fetchCached(url, cacheName, cacheTime) {
      const cacheTimestampName = cacheName + '-timestamp';
      const fetchTimestamp = localStorage.getItem(cacheTimestampName);
      if (fetchTimestamp && cacheTime && Date.now() - fetchTimestamp <= cacheTime)
        return localStorage.getItem(cacheName);
      const text = await fetch(url).then(r => r.text());
      localStorage.setItem(cacheName, text);
      localStorage.setItem(cacheTimestampName, Date.now());
      return text;
    }

    async function fetchAPI(version) {
      const key = `pptr-api-${version}`;
      let api = localStorage.getItem(key);
      if (!api) {
        const url = `https://raw.githubusercontent.com/GoogleChrome/puppeteer/${version}/docs/api.md`;
        api = await fetch(url).then(response => response.text());
        if (version !== 'master')
          localStorage.setItem(key, api);
      }
      return api;
    }
  }

  constructor(readmeText, releases) {
    super();
    this._readmeText = readmeText;
    this._releases = releases;
    this._initializeAPILifespan();
  }

  _initializeAPILifespan() {
    // Compute "since" and "until" versions for API entities.
    const classRegex = /### class:\s+(\w+)\s*$/;
    const eventRegex = /#### event:\s+'(\w+)'\s*$/;
    const methodRegex = /#### \w+\.([\w$]+)\(/;
    const nsRegex = /#### \w+\.(\w+)\s*$/;

    for (const release of this._releases) {
      release.classesLifespan = new Map();
      let classOutline = null;
      const titles = release.apiText.split('\n').filter(line => line.startsWith('###'));
      for (const title of titles) {
        // Handle classes
        if (classRegex.test(title)) {
          if (classOutline)
            release.classesLifespan.set(classOutline.name, classOutline);
          const className = title.match(classRegex)[1];
          classOutline = {
            name: className,
            since: release.name,
            until: '',
            // Maps of name -> first introduced version
            eventsSince: new Map(),
            methodsSince: new Map(),
            namespacesSince: new Map(),
            // Maps of name -> first removed version
            eventsUntil: new Map(),
            methodsUntil: new Map(),
            namespacesUntil: new Map(),
          };
        } else if (eventRegex.test(title)) {
          console.assert(classOutline);
          const eventName = title.match(eventRegex)[1];
          classOutline.eventsSince.set(eventName, release.name);
        } else if (methodRegex.test(title)) {
          console.assert(classOutline);
          const methodName = title.match(methodRegex)[1];
          classOutline.methodsSince.set(methodName, release.name);
        } else if (nsRegex.test(title)) {
          console.assert(classOutline);
          const nsName = title.match(nsRegex)[1];
          classOutline.namespacesSince.set(nsName, release.name);
        }
      }
      if (classOutline)
        release.classesLifespan.set(classOutline.name, classOutline);
    }

    // Compute "since" for classes, methods, namespaces and events.
    for (let i = this._releases.length - 2; i >= 0; --i) {
      const previousRelease = this._releases[i + 1];
      const release = this._releases[i];
      for (const [className, classOutline] of release.classesLifespan) {
        const previousClassOutline = previousRelease.classesLifespan.get(className);
        if (!previousClassOutline)
          continue;
        classOutline.since = previousClassOutline.since;
        for (const [eventName, since] of previousClassOutline.eventsSince) {
          if (classOutline.eventsSince.has(eventName))
            classOutline.eventsSince.set(eventName, since);
        }
        for (const [methodName, since] of previousClassOutline.methodsSince) {
          if (classOutline.methodsSince.has(methodName))
            classOutline.methodsSince.set(methodName, since);
        }
        for (const [namespaceName, since] of previousClassOutline.namespacesSince) {
          if (classOutline.namespacesSince.has(namespaceName))
            classOutline.namespacesSince.set(namespaceName, since);
        }
      }
    }
    // Compute "until" for classes, methods, namespaces and events.
    for (let i = 0; i < this._releases.length - 1; ++i) {
      const nextRelease = this._releases[i];
      const release = this._releases[i + 1];
      for (const [className, classOutline] of release.classesLifespan) {
        const nextReleaseOutline = nextRelease.classesLifespan.get(className);
        if (!nextReleaseOutline) {
          classOutline.until = nextRelease.name;
          for (const eventName of classOutline.eventsUntil.keys())
            classOutline.eventsUntil.set(eventName, nextRelease.name);
          for (const methodName of classOutline.methodsUntil.keys())
            classOutline.methodsUntil.set(methodName, nextRelease.name);
          for (const namespaceName of classOutline.namespacesUntil.keys())
            classOutline.namespacesUntil.set(namespaceName, nextRelease.name);
          continue;
        }
        classOutline.until = nextReleaseOutline.until;
        for (const eventName of classOutline.eventsSince.keys()) {
          if (nextReleaseOutline.eventsUntil.has(eventName))
            classOutline.eventsUntil.set(eventName, nextReleaseOutline.eventsUntil.get(eventName));
          else if (!nextReleaseOutline.eventsSince.has(eventName))
            classOutline.eventsUntil.set(eventName, nextRelease.name);
        }
        for (const methodName of classOutline.methodsSince.keys()) {
          if (nextReleaseOutline.methodsUntil.has(methodName))
            classOutline.methodsUntil.set(methodName, nextReleaseOutline.methodsUntil.get(methodName));
          else if (!nextReleaseOutline.methodsSince.has(methodName))
            classOutline.methodsUntil.set(methodName, nextRelease.name);
        }
        for (const namespaceName of classOutline.namespacesSince.keys()) {
          if (nextReleaseOutline.namespacesUntil.has(namespaceName))
            classOutline.namespacesUntil.set(namespaceName, nextReleaseOutline.namespacesUntil.get(namespaceName));
          else if (!nextReleaseOutline.namespacesSince.has(namespaceName))
            classOutline.namespacesUntil.set(namespaceName, nextRelease.name);
        }
      }
    }
  }

  name() {
    return 'Puppeteer';
  }

  defaultVersionName() {
    return this._releases[1].name;
  }

  versionNames() {
    return this._releases.map(release => release.name);
  }

  getVersion(name) {
    const release = this._releases.find(release => release.name === name);
    if (!release)
      return null;
    return new PPTRVersion(this._readmeText, release);
  }
}

class PPTRVersion extends App.ProductVersion {
  constructor(readmeText, {name, releaseNotes, apiText, classesLifespan}) {
    super();
    this._name = name;
    this._readmeText = readmeText;

    this.api = APIDocumentation.create(name, releaseNotes, apiText, classesLifespan);

    this._sidebarElements = [];
    this._entryToSidebarElement = new Map();
    this._initializeSidebarElements();

    this._searchItems = [];
    for (const apiClass of this.api.classes) {
      this._searchItems.push(PPTRSearchItem.createForClass(apiClass));
      for (const apiEvent of apiClass.events)
        this._searchItems.push(PPTRSearchItem.createForEvent(apiEvent));
      for (const apiNamespace of apiClass.namespaces)
        this._searchItems.push(PPTRSearchItem.createForNamespace(apiNamespace));
      for (const apiMethod of apiClass.methods)
        this._searchItems.push(PPTRSearchItem.createForMethod(apiMethod));
    }
  }

  name() {
    return this._name;
  }

  searchItems() {
    return this._searchItems;
  }

  sidebarElements() {
    return this._sidebarElements;
  }

  content(contentId) {
    if (!contentId) {
      const element = document.createElement('pptr-api'); const contentBox = document.createElement('content-box'); element.appendChild(contentBox);
      contentBox.appendChild(APIDocumentation.markdownToDOM(this._readmeText));
      return { element, title: '' };
    }
    if (contentId === 'outline') {
      const element = document.createElement('pptr-api');
      element.appendChild(this.api.createOutline());
      return { element, title: '' };
    }
    const entry = this.api.idToEntry(contentId);
    if (!entry)
      return null;
    if (entry instanceof APIClass) {
      const element = this._showAPIClass(entry);
      const title = entry.name;
      const selectedSidebarElement = this._entryToSidebarElement.get(entry);
      return {element, title, selectedSidebarElement};
    }
    if (entry instanceof APISection) {
      const element = document.createElement('pptr-api');
      this._renderElements(element, null, [entry.element]);
      const title = '';
      const selectedSidebarElement = this._entryToSidebarElement.get(entry);
      return {element, title, selectedSidebarElement};
    }
    const element = this._showAPIClass(entry.apiClass);
    const scrollAnchor = this._scrollAnchor(entry.element);
    const title = entry.apiClass.loweredName + '.' + entry.name;
    const selectedSidebarElement = this._entryToSidebarElement.get(entry.apiClass);
    return {element, title, selectedSidebarElement, scrollAnchor};
  }

  _initializeSidebarElements() {
    this._sidebarElements = [];
    const resourcesDivider = document.createElement('pptr-sidebar-divider');
    resourcesDivider.textContent = 'Resources';
    this._sidebarElements.push(resourcesDivider);
    this._sidebarElements.push(createResourcesItem(iconURL('./images/slack.svg', 'slack'), 'Slack', 'https://join.slack.com/t/puppeteer/shared_invite/enQtMzU4MjIyMDA5NTM4LTM1OTdkNDhlM2Y4ZGUzZDdjYjM5ZWZlZGFiZjc4MTkyYTVlYzIzYjU5NDIyNzgyMmFiNDFjN2UzNWU0N2ZhZDc'));
    this._sidebarElements.push(createResourcesItem(iconURL('./images/stackoverflow.svg', 'stackoverflow'), 'StackOverflow', 'https://stackoverflow.com/questions/tagged/puppeteer'));
    this._sidebarElements.push(createResourcesItem(iconURL('./images/github.png', 'github'), 'Github', 'https://github.com/GoogleChrome/puppeteer/issues'));
    this._sidebarElements.push(createResourcesItem(iconURL('./images/wrench.svg', 'troubleshooting'), 'ToubleShooting', 'https://github.com/GoogleChrome/puppeteer/blob/master/docs/troubleshooting.md'));

    const apiDivider = document.createElement('pptr-sidebar-divider');
    apiDivider.innerHTML = `API <a class=pptr-outline-icon href='${app.linkURL('Puppeteer', this.api.version, 'outline')}'><img src='./images/outline.svg'></img></a>`;
    const outlineIcon = document.createElement('a');
    this._sidebarElements.push(apiDivider);

    for (const apiEntry of [...this.api.sections, ...this.api.classes]) {
      const icon = apiEntry instanceof APIClass ?  document.createElement('pptr-class-icon') : null;
      const item = createItem(icon, apiEntry.name, apiEntry.linkURL());
      this._sidebarElements.push(item);
      this._entryToSidebarElement.set(apiEntry, item);
    }

    function iconURL(url, className) {
      const img = document.createElement('img');
      img.classList.add(className);
      img.src = url;
      return img;
    }

    function createItem(icon, text, route) {
      const item = document.createElement('a');
      item.classList.add('pptr-sidebar-item');
      item.href = route;
      if (icon)
        item.appendChild(icon);
      item.appendChild(document.createTextNode(text));
      return item;
    }

    function createResourcesItem(icon, text, route) {
      const item = document.createElement('a');
      item.classList.add('pptr-sidebar-icon-item');
      item.href = route;
      item.target = '_blank';
      if (icon)
        item.appendChild(icon);
      const title = document.createElement('span');
      title.textContent = text;
      item.appendChild(title);
      return item;
    }
  }

  _showAPIClass(apiClass) {
    const element = document.createElement('pptr-api');

    this._insertBox(element).appendChild(apiClass.element);

    this._renderElements(element, 'NameSpaces', apiClass.namespaces.map(ns => ns.element));
    this._renderElements(element, 'Events', apiClass.events.map(e => e.element));
    this._renderElements(element, 'Methods', apiClass.methods.map(method => method.element));
    return element;
  }

  _scrollAnchor(entryElement) {
    if (entryElement.previousSibling && entryElement.previousSibling.tagName === 'CONTENT-DELIMETER')
      return entryElement.previousSibling;
    let parentBox = entryElement;
    while (parentBox && parentBox.tagName !== 'CONTENT-BOX')
      parentBox = parentBox.parentElement;
    return parentBox;
  }

  _insertBox(container) {
    const box = document.createElement('content-box');
    container.appendChild(box);
    return box;
  }

  _renderElements(container, title, elements) {
    if (!elements.length)
      return;
    if (title) {
      const header = document.createElement('h3');
      header.textContent = title;
      container.appendChild(header);
    }
    const box = this._insertBox(container);
    let lastDelimeter = null;
    for (const element of elements) {
      box.appendChild(element);
      lastDelimeter = document.createElement('content-delimeter');
      box.appendChild(lastDelimeter);
    }
    lastDelimeter.remove();
  }
}

class PPTRSearchItem extends SearchComponent.Item {
  static createForMethod(apiMethod) {
    const className = apiMethod.apiClass.loweredName;
    const name = apiMethod.name;
    const args = apiMethod.args;

    const desc = apiMethod.element.querySelector('p');
    const text = `${className}.${name}(${args})`;
    const titleRenderer = matches => renderTokensWithMatches(matches, [
      {text: className + '.', tagName: 'search-item-api-method-class'},
      {text: `${name}(${args})`, tagName: 'search-item-api-method-name'},
    ]);
    return new PPTRSearchItem(apiMethod, text, 'pptr-method-icon', titleRenderer, desc ? desc.textContent : '');
  }

  static createForEvent(apiEvent) {
    const className = apiEvent.apiClass.loweredName;
    const name = apiEvent.name;

    const desc = apiEvent.element.querySelector('p');
    const text = `${className}.on('${name}')`;
    const titleRenderer = matches => renderTokensWithMatches(matches, [
      {text: className + '.on(', tagName: 'search-item-api-method-class'},
      {text: `'${name}'`, tagName: 'search-item-api-method-name'},
      {text: ')', tagName: 'search-item-api-method-class'},
    ]);
    return new PPTRSearchItem(apiEvent, text, 'pptr-event-icon', titleRenderer, desc ? desc.textContent : '');
  }

  static createForNamespace(apiNamespace) {
    const className = apiNamespace.apiClass.loweredName;
    const name = apiNamespace.name;

    const desc = apiNamespace.element.querySelector('p');
    const text = `${className}.${name}`;
    const titleRenderer = matches => renderTokensWithMatches(matches, [
      {text: className + '.', tagName: 'search-item-api-method-class'},
      {text: name, tagName: 'search-item-api-method-name'},
    ]);
    return new PPTRSearchItem(apiNamespace, text, 'pptr-ns-icon', titleRenderer, desc ? desc.textContent : '');
  }

  static createForClass(apiClass) {
    const className = apiClass.name;

    const desc = apiClass.element.querySelector('p');
    const text = className;
    const titleRenderer = matches => renderTokensWithMatches(matches, [
      {text: className, tagName: 'search-item-api-method-name'},
    ]);
    return new PPTRSearchItem(apiClass, text, 'pptr-class-icon', titleRenderer, desc ? desc.textContent : '');
  }

  constructor(apiEntry, text, iconTagName, titleRenderer, description) {
    super();
    this._url = apiEntry.linkURL();
    this._text = text;
    this._iconTagName = iconTagName;
    this._titleRenderer = titleRenderer;
    this._description = description;

    this._subtitleElement = null;
    this._iconElement = null;
  }

  url() {
    return this._url;
  }

  text() {
    return this._text;
  }

  titleElement(matches) {
    return this._titleRenderer.call(null, matches);
  }

  iconElement() {
    if (!this._iconElement && this._iconTagName)
      this._iconElement = document.createElement(this._iconTagName);
    return this._iconElement;
  }

  subtitleElement() {
    if (!this._description)
      return null;
    if (!this._subtitleElement)
      this._subtitleElement = document.createTextNode(this._description);
    return this._subtitleElement;
  }
}

/**
 * @param {string} text
 * @param {!Array<number>} matches
 * @param {number} fromIndex
 * @param {number} fromIndex
 * @return {!Element}
 */
function renderTokensWithMatches(matches, tokens) {
  if (!matches.length) {
    const fragment = document.createDocumentFragment();
    for (let token of tokens) {
      if (token.tagName) {
        const node = document.createElement(token.tagName);
        node.textContent = token.text;
        fragment.appendChild(node);
      } else {
        fragment.appendChild(document.createTextNode(token.text));
      }
    }
    return fragment;
  }

  const fragment = document.createDocumentFragment();
  let offset = 0;
  let matchesSet = new Set(matches);
  for (let token of tokens) {
    const result = token.tagName ? document.createElement(token.tagName) : document.createDocumentFragment();
    let from = 0;
    let lastInsideHighlight = false;
    for (let to = 0; to <= token.text.length; ++to) {
      const insideHighlight = matchesSet.has(to + offset);
      if (insideHighlight === lastInsideHighlight && to < token.text.length)
        continue;
      if (from < to) {
        if (lastInsideHighlight) {
          const node = document.createElement('search-highlight');
          node.textContent = token.text.substring(from, to);
          result.appendChild(node);
        } else {
          const node = document.createTextNode(token.text.substring(from, to));
          result.appendChild(node);
        }
        from = to;
      }
      lastInsideHighlight = insideHighlight;
    }
    offset += token.text.length;
    fragment.appendChild(result);
  }
  return fragment;
}


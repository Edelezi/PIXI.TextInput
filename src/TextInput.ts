import * as PIXI from 'pixi.js';
import { DisplayObject, IDestroyOptions, Renderer, TextStyleAlign } from 'pixi.js';

type StyleDeclaration = Omit<Partial<CSSStyleDeclaration>, 'length' | 'parentRule'>;

type StateType = 'DEFAULT' | 'FOCUSED' | 'DISABLED';

type BoxGenerationFunction = (w: number, h: number, state: StateType) => PIXI.Graphics;

type BoundsRect = {
	height: number;
	width: number;
	top: number;
	left: number;
};

type State = {
	state: StateType;
	canvasBounds?: BoundsRect;
	worldTransform?: PIXI.Matrix;
	worldAlpha?: number;
	worldVisible?: boolean;
	inputBounds?: DOMRect;
};

declare interface IFontMetrics {
	ascent: number;
	descent: number;
	fontSize: number;
}

function getProperty<T, K extends keyof T>(o: T, propertyName: K): T[K] {
	return o[propertyName]; // o[propertyName] is of type T[K]
}

export class TextInput extends PIXI.Container {
	public state: StateType = 'DEFAULT';

	private readonly _textInputStyle: StyleDeclaration;
	private _boxGeneratorFunction?: BoxGenerationFunction;

	private readonly _multiline: boolean;

	private _lastRenderer?: Renderer;
	private _resolution: number = 0;
	private _canvasBounds: BoundsRect = { top: 0, left: 0, width: 0, height: 0 };

	private _surrogateMask?: PIXI.Graphics;
	private _surrogateHitbox?: PIXI.Graphics;
	private _surrogate?: PIXI.Text;
	private _box?: DisplayObject;

	private _fontMetrics?: IFontMetrics;
	private _boxCache: Record<string, DisplayObject> = {};
	private _previous: State = {
		state: 'DEFAULT',
	};
	private _domAdded = false;
	private _domVisible = true;
	private _placeholder = '';
	private _placeholderColor = 0xa9a9a9;
	private _selection = [0, 0];
	private _restrictValue = '';

	private _substituted: boolean = false;
	private _disabled: boolean = false;
	private _maxLength: string = '';
	private _restrictRegex?: RegExp;

	private readonly _domInput: HTMLTextAreaElement | HTMLInputElement;

	constructor(input: StyleDeclaration, multiline?: boolean, boxGenerationFunction?: BoxGenerationFunction, boxParams?: any) {
	super();
	this._textInputStyle = Object.assign(
		{
			position: 'absolute',
			background: 'none',
			border: 'none',
			outline: 'none',
			transformOrigin: '0 0',
			lineHeight: '1',
			multiline: true,
		},
		input,
	);

	if (boxGenerationFunction) {
		this._boxGeneratorFunction = boxGenerationFunction;
	} else if (boxParams) {
		this._boxGeneratorFunction = (w: number, h: number, state: StateType) => DefaultBoxGenerator(boxParams)(w, h, state);
	} else
	this._boxGeneratorFunction = undefined;

	this._multiline = multiline || false;

	if (this._multiline) {
	this._domInput = document.createElement('textarea');
	this._domInput.style.resize = 'none';
} else {
	this._domInput = document.createElement('input');
	this._domInput.type = 'text';
}

let key: keyof StyleDeclaration;
for (key in this._textInputStyle) {
	Object.defineProperty(this._domInput.style, key, {
		value: getProperty(this._textInputStyle, key),
	});
	// this._domInput.style[key] = getProperty(this._textInputStyle, key);
}

this.substituteText = true;
this.setState('DEFAULT');
this.addListeners();
}


// GETTERS & SETTERS

public get substituteText(): boolean {
	return this._substituted;
}

public set substituteText(substitute: boolean) {
	if (this._substituted === substitute)
		return;

	this._substituted = substitute;

	if (substitute) {
		this.createSurrogate();
		this._domVisible = false;
	} else {
		this.destroySurrogate();
		this._domVisible = true;
	}
	this.placeholder = this._placeholder;
	this.update();
}

public get placeholder(): string {
	return this._placeholder;
}

public set placeholder(text) {
	this._placeholder = text;
	if (this._substituted) {
		this.updateSurrogate();
		if (this._domInput) {
			this._domInput.placeholder = '';
		}
	} else {
		if (this._domInput) {
			this._domInput.placeholder = text;
		}
	}
}

public get disabled(): boolean {
	return this._disabled;
}

public set disabled(disabled: boolean) {
	this._disabled = disabled;
	this._domInput.disabled = disabled;
	this.setState(disabled ? 'DISABLED' : 'DEFAULT');
}

public get maxLength(): string {
	return this._maxLength;
}

public set maxLength(length) {
	this._maxLength = length;
	this._domInput.setAttribute('maxlength', length);
}

public get restrict(): RegExp | undefined {
	return this._restrictRegex;
}

public set restrict(regex) {
	if (regex instanceof RegExp) {
		let regexStr = regex.toString().slice(1, -1);

		if (regexStr.charAt(0) !== '^')
			regexStr = '^' + regexStr;

		if (regexStr.charAt(regexStr.length - 1) !== '$')
			regexStr = regexStr + '$';

		regex = new RegExp(regexStr);
	} else {
		regex = new RegExp('^[' + regex + ']*$');
	}

	this._restrictRegex = regex;
}

public get text(): string {
	return this._domInput.value;
}

public set text(text) {
	this._domInput.value = text;
	if (this._substituted) this.updateSurrogate();
}

public get htmlInput() {
	return this._domInput;
}

public focus = () => {
	if (this._substituted && !this._domVisible)
		this.setDOMInputVisible(true);

	this._domInput.focus();

};

public blur = () => {
	this._domInput.blur();
};

public select = () => {
	this.focus();
	this._domInput.select();
};

public setInputStyle = (key: keyof StyleDeclaration, value: any) => {
	this._textInputStyle[key] = value;
	this._domInput.style[key] = value;

	if (this._substituted && (key === 'fontFamily' || key === 'fontSize'))
		this.updateFontMetrics();

	if (this._lastRenderer)
		this.update();
};

public destroy = (options?: IDestroyOptions | boolean) => {
	this.destroyBoxCache();
	super.destroy(options);
};

private addListeners = () => {
	this.on('added', this.onAdded);
	this.on('removed', this.onRemoved);
	this._domInput.addEventListener('keydown', this.onInputKeyDown);
	this._domInput.addEventListener('input', this.onInputInput);
	this._domInput.addEventListener('keyup', this.onInputKeyUp);
	this._domInput.addEventListener('focus', this.onFocused);
	this._domInput.addEventListener('blur', this.onBlurred);
};

private onInputKeyDown = (e: Event) => {
	if (this._domInput.selectionStart && this._domInput.selectionEnd) {
		this._selection = [
			this._domInput.selectionStart,
			this._domInput.selectionEnd,
		];
	}

	this.emit('keydown', (e as KeyboardEvent).code);
};

private onInputInput = (e: Event) => {
	if (this._restrictRegex)
		this.applyRestriction();

	if (this._substituted)
		this.updateSubstitution();

	this.emit('input', this.text);
};

private onInputKeyUp = (e: Event) => {
	this.emit('keyup', (e as KeyboardEvent).code);
};

private onFocused = () => {
	this.setState('FOCUSED');
	this.emit('focus');
};

private onBlurred = () => {
	this.setState('DEFAULT');
	this.emit('blur');
};

private onAdded = () => {
	document.body.appendChild(this._domInput);
	this._domInput.style.display = 'none';
	this._domAdded = true;
};

private onRemoved = () => {
	document.body.removeChild(this._domInput);
	this._domAdded = false;
};

private setState = (state: StateType) => {
	this.state = state;
	this.updateBox();
	if (this._substituted)
		this.updateSubstitution();
};

public render = (renderer: Renderer) => {
	super.render(renderer);
	this.renderInternal(renderer);
};

private renderInternal = (renderer: Renderer) => {
	this._resolution = renderer.resolution;
	this._lastRenderer = renderer;
	this._canvasBounds = this.getCanvasBounds();
	if (this.needsUpdate())
		this.update();
};

private update = () => {
	this.updateDOMInput();
	if (this._substituted) this.updateSurrogate();
	this.updateBox();
};

private updateBox = () => {
	if (!this._boxGeneratorFunction)
		return;

	if (this.needsNewBoxCache())
		this.buildBoxCache();

	if (this.state === this._previous.state
		&& this._box === this._boxCache[this.state])
		return;

	if (this._box)
		this.removeChild(this._box);

	this._box = this._boxCache[this.state];
	this.addChildAt(this._box, 0);
	this._previous.state = this.state;
};

private updateSubstitution = () => {
	if (this.state === 'FOCUSED') {
		this._domVisible = true;
		if (this._surrogate) {
			this._surrogate.visible = this.text.length === 0;
		}
	} else {
		this._domVisible = false;
		if (this._surrogate) {
			this._surrogate.visible = true;
		}
	}
	this.updateDOMInput();
	this.updateSurrogate();
};

private updateDOMInput = () => {
	if (!this._canvasBounds)
		return;

	this._domInput.style.top = (this._canvasBounds.top || 0) + 'px';
	this._domInput.style.left = (this._canvasBounds.left || 0) + 'px';
	this._domInput.style.transform = this.pixiMatrixToCSS(this.getDOMRelativeWorldTransform());
	this._domInput.style.opacity = this.worldAlpha.toString();
	this.setDOMInputVisible(this.worldVisible && this._domVisible);

	this._previous.canvasBounds = this._canvasBounds;
	this._previous.worldTransform = this.worldTransform.clone();
	this._previous.worldAlpha = this.worldAlpha;
	this._previous.worldVisible = this.worldVisible;
};

private applyRestriction = () => {
	if (this._restrictRegex?.test(this.text)) {
		this._restrictValue = this.text;
	} else {
		this.text = this._restrictValue;
		this._domInput.setSelectionRange(
			this._selection[0],
			this._selection[1],
		);
	}
};


// STATE COMPAIRSON (FOR PERFORMANCE BENEFITS)

private needsUpdate = () => (
	!this.comparePixiMatrices(this.worldTransform, this._previous.worldTransform)
	|| !this.compareClientRects(this._canvasBounds, this._previous.canvasBounds)
	|| this.worldAlpha !== this._previous.worldAlpha
	|| this.worldVisible !== this._previous.worldVisible
);

private needsNewBoxCache = () => {
	let inputBounds = this.getDOMInputBounds();
	return (
		!this._previous.inputBounds
		|| inputBounds.width !== this._previous.inputBounds.width
		|| inputBounds.height !== this._previous.inputBounds.height
	);
};


// INPUT SUBSTITUTION

private createSurrogate = () => {
	this._surrogateHitbox = new PIXI.Graphics();
	this._surrogateHitbox.alpha = 0;
	this._surrogateHitbox.interactive = true;
	this._surrogateHitbox.cursor = 'text';
	this._surrogateHitbox.on('pointerdown', this.onSurrogateFocus.bind(this));
	this.addChild(this._surrogateHitbox);

	this._surrogateMask = new PIXI.Graphics();
	this.addChild(this._surrogateMask);

	this._surrogate = new PIXI.Text('', {});
	this.addChild(this._surrogate);

	this._surrogate.mask = this._surrogateMask;

	this.updateFontMetrics();
	this.updateSurrogate();
};

private updateSurrogate = () => {
	if (!this._surrogate) {
		return;
	}

	let padding = this.deriveSurrogatePadding();
	let inputBounds = this.getDOMInputBounds();

	this._surrogate.style = this.deriveSurrogateStyle();
	this._surrogate.style.padding = Math.max.apply(Math, padding);
	this._surrogate.y = this._multiline ? padding[0] : (inputBounds.height - this._surrogate.height) / 2;
	this._surrogate.x = padding[3];
	this._surrogate.text = this.deriveSurrogateText();

	switch (this._surrogate.style.align) {
		case 'left':
			this._surrogate.x = padding[3];
			break;

		case 'center':
			this._surrogate.x = inputBounds.width * 0.5 - this._surrogate.width * 0.5;
			break;

		case 'right':
			this._surrogate.x = inputBounds.width - padding[1] - this._surrogate.width;
			break;
	}

	this.updateSurrogateHitbox(inputBounds);
	this.updateSurrogateMask(inputBounds, padding);
};

private updateSurrogateHitbox = (bounds: DOMRect) => {
	if (!this._surrogateHitbox) {
		return;
	}

	this._surrogateHitbox.clear();
	this._surrogateHitbox.beginFill(0);
	this._surrogateHitbox.drawRect(0, 0, bounds.width, bounds.height);
	this._surrogateHitbox.endFill();
	this._surrogateHitbox.interactive = !this._disabled;
};

private updateSurrogateMask = (bounds: DOMRect, padding: number[]) => {
	if (!this._surrogateMask) {
		return;
	}

	this._surrogateMask.clear();
	this._surrogateMask.beginFill(0);
	this._surrogateMask.drawRect(padding[3], 0, bounds.width - padding[3] - padding[1], bounds.height);
	this._surrogateMask.endFill();
};

private destroySurrogate = () => {
	if (!this._surrogate || !this._surrogateHitbox) return;

	this.removeChild(this._surrogate);
	this.removeChild(this._surrogateHitbox);

	this._surrogate.destroy();
	this._surrogateHitbox.destroy();

	this._surrogate = undefined;
	this._surrogateHitbox = undefined;
};

private onSurrogateFocus = () => {
	this.setDOMInputVisible(true);
	//sometimes the input is not being focused by the mouseclick
	setTimeout(this.ensureFocus.bind(this), 10);
};

private ensureFocus = () => {
	if (!this.hasFocus())
		this.focus();
};

private deriveSurrogateStyle = () => {
	let style = new PIXI.TextStyle();

	let key: keyof StyleDeclaration;
	for (key in this._textInputStyle) {
		switch (key) {
			case 'color':
				style.fill = this._textInputStyle.color as string;
				break;

			case 'fontFamily':
			case 'fontSize':
			case 'fontWeight':
			case 'fontVariant':
			case 'fontStyle':
				// @ts-ignore
				style[key] = this._textInputStyle[key];
				break;

			case 'letterSpacing':
				style.letterSpacing = parseFloat(this._textInputStyle.letterSpacing as string);
				break;

			case 'textAlign':
				style.align = this._textInputStyle.textAlign as TextStyleAlign;
				break;
		}
	}

	if (this._multiline) {
		style.lineHeight = parseFloat(style.fontSize.toString());
		style.wordWrap = true;
		style.wordWrapWidth = this.getDOMInputBounds().width;
	}

	if (this._domInput.value.length === 0)
		style.fill = this._placeholderColor;

	return style;
};

private deriveSurrogatePadding = () => {
	let indent = this._textInputStyle.textIndent ? parseFloat(this._textInputStyle.textIndent) : 0;

	if (this._textInputStyle.padding && this._textInputStyle.padding.length > 0) {
		let components = this._textInputStyle.padding.trim().split(' ');

		if (components.length === 1) {
			let padding = parseFloat(components[0]);
			return [padding, padding, padding, padding + indent];
		} else if (components.length === 2) {
			let paddingV = parseFloat(components[0]);
			let paddingH = parseFloat(components[1]);
			return [paddingV, paddingH, paddingV, paddingH + indent];
		} else if (components.length === 4) {
			let padding = components.map(component => {
				return parseFloat(component);
			});
			padding[3] += indent;
			return padding;
		}
	}

	return [0, 0, 0, indent];
};

private deriveSurrogateText = () => {
	if (this._domInput.value.length === 0)
		return this._placeholder;

	if (this._domInput.type === 'password')
		return '•'.repeat(this._domInput.value.length);

	return this._domInput.value;
};

private updateFontMetrics = () => {
	const style = this.deriveSurrogateStyle();
	const font = style.toFontString();

	this._fontMetrics = PIXI.TextMetrics.measureFont(font);
};


// CACHING OF INPUT BOX GRAPHICS

private buildBoxCache = () => {
	this.destroyBoxCache();

	let states: StateType[] = ['DEFAULT', 'FOCUSED', 'DISABLED'];
	let inputBounds = this.getDOMInputBounds();

	if (!this._boxGeneratorFunction) {
		return;
	}

	for (let i in states) {
		this._boxCache[states[i]] = this._boxGeneratorFunction(
			inputBounds.width,
			inputBounds.height,
			states[i],
		);
	}

	this._previous.inputBounds = inputBounds;
};

private destroyBoxCache = () => {
	if (this._box) {
		this.removeChild(this._box);
		this._box = undefined;
	}

	for (let i in this._boxCache) {
		this._boxCache[i].destroy();
		delete this._boxCache[i];
	}
};


// HELPER FUNCTIONS

private hasFocus = () => document.activeElement === this._domInput;

private setDOMInputVisible = (visible: boolean) => {
	this._domInput.style.display = visible ? 'block' : 'none';
};

private getCanvasBounds = (): BoundsRect => {
	if (!this._lastRenderer) {
		return { top: 0, left: 0, height: 0, width: 0 };
	}

	let rect = this._lastRenderer.view.getBoundingClientRect();
	let bounds = { top: rect.top, left: rect.left, width: rect.width, height: rect.height };
	bounds.left += window.scrollX;
	bounds.top += window.scrollY;
	return bounds;
};

private getDOMInputBounds = () => {
	let remove_after = false;

	if (!this._domAdded) {
		document.body.appendChild(this._domInput);
		remove_after = true;
	}

	let org_transform = this._domInput.style.transform;
	let org_display = this._domInput.style.display;
	this._domInput.style.transform = '';
	this._domInput.style.display = 'block';
	let bounds = this._domInput.getBoundingClientRect();
	this._domInput.style.transform = org_transform;
	this._domInput.style.display = org_display;

	if (remove_after)
		document.body.removeChild(this._domInput);

	return bounds;
};

private getDOMRelativeWorldTransform = () => {
	if (!this._lastRenderer) {
		return this.worldTransform.clone();
	}

	let canvasBounds = this._lastRenderer.view.getBoundingClientRect();
	let matrix = this.worldTransform.clone();

	matrix.scale(this._resolution, this._resolution);
	matrix.scale(canvasBounds.width / this._lastRenderer?.width,
		canvasBounds.height / this._lastRenderer?.height);
	return matrix;
};

private pixiMatrixToCSS = (m: PIXI.Matrix) => 'matrix(' + [m.a, m.b, m.c, m.d, m.tx, m.ty].join(',') + ')';

private comparePixiMatrices = (m1?: PIXI.Matrix, m2?: PIXI.Matrix) => {
	if (!m1 || !m2) return false;
	return (
		m1.a === m2.a
		&& m1.b === m2.b
		&& m1.c === m2.c
		&& m1.d === m2.d
		&& m1.tx === m2.tx
		&& m1.ty === m2.ty
	);
};

private compareClientRects = (r1?: BoundsRect, r2?: BoundsRect): boolean => {
	if (!r1 || !r2) return false;
	return (
		r1.left === r2.left
		&& r1.top === r2.top
		&& r1.width === r2.width
		&& r1.height === r2.height
	);
};
}

type BoxStyles = {
	default: BoxStyleConfig;
	focused?: BoxStyleConfig;
	disabled?: BoxStyleConfig;
};

type BoxStyleConfig = {
	fill: number;
	rounded?: number;
	stroke?: {
		color: number;
		width: number;
		alpha: number;
	}
};

function DefaultBoxGenerator(styles?: BoxStyles) {
	const stylesObj = styles || { default: { fill: 0xcccccc } };

	stylesObj.focused = stylesObj.focused || stylesObj.default;
	stylesObj.disabled = stylesObj.disabled || stylesObj.default;

	return function (w: number, h: number, state: StateType) {
		let style = stylesObj[state.toLowerCase() as keyof BoxStyles];
		let box = new PIXI.Graphics();


		if (style?.fill)
			box.beginFill(style.fill);

		if (style?.stroke)
			box.lineStyle(
				style.stroke.width || 1,
				style.stroke.color || 0,
				style.stroke.alpha || 1,
			);

		if (style?.rounded)
			box.drawRoundedRect(0, 0, w, h, style.rounded);
		else
			box.drawRect(0, 0, w, h);

		box.endFill();
		box.closePath();

		return box;
	};
}

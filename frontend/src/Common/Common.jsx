import { useNavigate, useLocation } from "react-router-dom";
import { useRef, useEffect, useReducer } from 'react';

/**
 * MenuHelp：UI 无关的菜单模型（移植自参考项目）。
 * - 输入菜单配置（itemKey 或 key 均可），自动归一化并过滤 hidden；
 * - 输出 semi-ui 约定字段（itemKey / items / text）与通用数据：navItems / openKeys /
 *   selectedKeys / breadcrumbs / routeConfigs；
 * - 权限过滤：注入 options.permissions（允许的 itemKey 数组）后自动过滤，未注入放行全部
 *   （本项目无鉴权，通常不注入）。
 */
class MenuHelp {
    constructor(menuItems, options = {}) {
        this._permissions = options.permissions ?? null;
        this._navAdapter = options.navAdapter || null;
        this.menuItems = menuItems;
        this.all_items = [];
        this.items = [];
        menuItems.map(lv1 => {
            if (!this._permissionPass(lv1)) return;
            var item = { ...lv1, ...{ items: (lv1.items || []).filter(c => this._permissionPass(c)).map(lv2 => ({ ...lv2 })) } };
            this.all_items.push(item);
            if (!item.hidden) {
                this.items.push({ ...item, ...{ items: item.items.filter(c => !c.hidden) } });
            }
        });
        this._open = null;
        this._select = null;
        this._openKey = '';
        this._selectKey = '';
        this.update();
    }
    _permissionPass(item) {
        if (this._permissions == null) return true;
        return this._permissions.includes(this._keyOf(item));
    }
    _matchPath(pattern, pathname) {
        if (!pattern) return false;
        if (pattern === pathname) return true;
        var regexStr = pattern
            .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
            .replace(/:[^/]+/g, '[^/]+')
            .replace(/\\\*/g, '.*');
        return new RegExp('^' + regexStr + '$').test(pathname);
    }
    _keyOf(item) {
        return item.itemKey || item.key;
    }
    update = (path) => {
        this._open = null;
        this._select = null;
        this._openKey = '';
        this._selectKey = '';
        if (!path) path = window.location.pathname;
        this.all_items.map(item => {
            var childMatch = null;
            if (item.items && item.items.length > 0) {
                item.items.map(i => {
                    if (this._matchPath(i.url, path)) childMatch = i;
                });
            }
            if (childMatch) {
                this._open = item;
                this._select = childMatch;
                this._openKey = this._keyOf(item);
                this._selectKey = childMatch.hidden ? this._keyOf(item) : this._keyOf(childMatch);
            }
            else if (this._matchPath(item.url, path)) {
                this._select = item;
                this._openKey = this._keyOf(item);
                this._selectKey = this._keyOf(item);
            }
        });
        return this;
    };
    get openKey() { return this._openKey; }
    get selectKey() { return this._selectKey; }
    get openItem() { return this._open; }
    get selectItem() { return this._select; }
    get breadcrumbs() {
        var rs = [];
        if (this._open && this._open.text) rs.push(this._open.text);
        if (this._select && this._select.text) rs.push(this._select.text);
        return rs;
    }
    get navItems() {
        var mapNode = (item) => {
            var node = {};
            Object.keys(item).forEach(k => {
                if (k === 'items' || k === 'hidden' || k === 'element') return;
                node[k] = item[k];
            });
            node.itemKey = this._keyOf(item);
            if (item.items && item.items.length > 0) node.items = item.items.map(mapNode);
            return node;
        };
        return this.items.map(mapNode);
    }
    get openKeys() { return this._openKey ? [this._openKey] : []; }
    get selectedKeys() { return this._selectKey ? [this._selectKey] : []; }
    get navProps() {
        var data = { items: this.navItems, defaultOpenKeys: this.openKeys, defaultSelectedKeys: this.selectedKeys };
        if (this.navPropsExtras) Object.assign(data, this.navPropsExtras);
        return this._navAdapter ? this._navAdapter(data) : data;
    }
    get routeConfigs() {
        var rs = [];
        this.all_items.map(item => {
            rs.push({ key: this._keyOf(item), path: item.url, element: item.element });
            if (item.items && item.items.length > 0) {
                item.items.map(i => rs.push({ key: this._keyOf(i), path: i.url, element: i.element }));
            }
        });
        return rs;
    }
    findItemByKey(key) {
        var rs = null;
        this.all_items.map(item => {
            if (this._keyOf(item) === key) rs = item;
            if (item.items) item.items.map(i => { if (this._keyOf(i) === key) rs = i; });
        });
        return rs;
    }
}

/**
 * useMenuHelp：MenuHelp 的 Hook 封装。path 变化时自动 update 并触发重渲染，
 * 内置 onSelect 导航回调（点击菜单项按 url 跳转）。
 */
function useMenuHelp(menuItems, pathOrOptions, maybeOptions) {
    var navigate = useNavigate();
    var path = typeof pathOrOptions === 'string' ? pathOrOptions : useLocation().pathname;
    var options = typeof pathOrOptions === 'string' ? maybeOptions : pathOrOptions;
    var menuRef = useRef(null);
    if (!menuRef.current) menuRef.current = new MenuHelp(menuItems, options);
    var [, force] = useReducer(c => c + 1, 0);
    useEffect(() => {
        menuRef.current.update(path);
        force();
    }, [path]);
    menuRef.current.navPropsExtras = {
        onSelect: (data) => {
            var key = data.itemKey ?? data.key;
            var item = menuRef.current.findItemByKey(key);
            if (item && item.url) navigate(item.url);
        }
    };
    return menuRef.current;
}

export { MenuHelp, useMenuHelp };

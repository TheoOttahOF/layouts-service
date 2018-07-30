import {eSnapValidity, Resolver, SnapTarget} from './Resolver';
import {Signal2} from './Signal';
import {SnapGroup} from './SnapGroup';
import {SnapView} from './SnapView';
import {eTransformType, Mask, SnapWindow, WindowState} from './SnapWindow';
import {Point} from './utils/PointUtils';
import {MeasureResult, RectUtils} from './utils/RectUtils';

const UNDOCK_MOVE_SCALE = 30;

/**
 * For passing state between service and view.
 *
 * May not be necessary. This is still WIP/TBD.
 */
export interface SnapState {
    /**
     * The group currently being dragged by the user.
     *
     * Only set when user is actually dragging a window, otherwise null. When this is null, other values within this
     * interface do not apply.
     */
    activeGroup: SnapWindow|null;

    /**
     * The current candidate for the snapping action. The group to which 'activeGroup' will be snapped to if the user
     * releases the window right now.
     *
     * Will be null when there is no valid snap target.
     */
    target: SnapTarget|null;
}

export class SnapService {
    private windows: SnapWindow[];
    private groups: SnapGroup[];

    private resolver: Resolver;
    private view: SnapView;

    /**
     * A window has been added to a group.
     *
     * Signal will be fired AFTER all state updates.
     *
     * Arguments: (group: SnapGroup, window: SnapWindow)
     */
    public readonly onWindowAdded: Signal2<SnapGroup, SnapWindow> = new Signal2();

    /**
     * A window has been removed from a group.
     *
     * Signal will be fired AFTER all state updates.
     *
     * Arguments: (group: SnapGroup, window: SnapWindow)
     */
    public readonly onWindowRemoved: Signal2<SnapGroup, SnapWindow> = new Signal2();

    constructor() {
        this.windows = [];
        this.groups = [];
        this.resolver = new Resolver();
        this.view = new SnapView();

        const serviceId: string = fin.desktop.Application.getCurrent().uuid;

        fin.desktop.System.addEventListener('application-created', (event: fin.SystemBaseEvent) => {
            console.log('New application created: ' + event.uuid);
            this.registerApplication(event.uuid);
        });
        fin.desktop.System.getAllApplications((apps: fin.ApplicationInfo[]) => {
            console.log('Registering existing applications: ' + apps.map(app => app.uuid).join(', '));

            apps.forEach((app: fin.ApplicationInfo) => {
                if (app.uuid !== serviceId) {
                    this.registerApplication(app.uuid);
                }
            });
        });
    }

    public undock(target: {uuid: string; name: string}): void {
        const window: SnapWindow|undefined = this.windows.find((w) => {
            const identity = w.getIdentity();
            return target.uuid === identity.uuid && target.name === identity.name;
        });

        if (window) {
            const group: SnapGroup = window.getGroup();

            const offset = this.calculateOffset(window);

            window.setGroup(this.addGroup());

            window.offsetBy({x: Math.sign(offset.x ? offset.x : 1) * UNDOCK_MOVE_SCALE, y: Math.sign(offset.y ? offset.y : 1) * UNDOCK_MOVE_SCALE});

            // Revalidate the group after undocking (should handle e.g. window in middle of group being removed)
            group.onModified.emit(group, window);
        }
    }

    public deregister(target: {uuid: string; name: string}): void {
        // TODO (SERVICE-132)
    }

    /**
     * Explodes a group. All windows in the group are unlocked.
     * @param groupMember A window which is a member of the group to be exploded.
     */
    public explodeGroup(targetWindow: {uuid: string; name: string}): void {
        // NOTE: Since there is currently not a schema to identify a group, this method
        // accepts a window that is a member of the group. Once there is a way of uniquely
        // identifying groups, this can be changed

        // Get the group containing the targetWindow
        const group: SnapGroup|undefined = this.groups.find((g) => {
            const windows = g.windows;
            return windows
                       .filter((w) => {
                           const identity = w.getIdentity();
                           return targetWindow.uuid === identity.uuid && targetWindow.name === identity.name;
                       })
                       .length > 0;
        });


        // Exploding only makes sense if there is more than one window in the group.
        if (group && group.length > 1) {
            const windows = group.windows;

            // Determine the offset for each window before modifying and window state
            const offsets: Point[] = [];
            for (let index = 0; index < windows.length; index++) {
                const window = windows[index];
                const offset = this.calculateOffset(window);
                offsets[index] = offset;
            }

            for (let index = 0; index < windows.length; index++) {
                const window = windows[index];
                // Undock the windows
                window.setGroup(this.addGroup());
                // Apply previously calculated offset
                const offset = offsets[index];
                window.offsetBy({x: Math.sign(offset.x) * 0.5 * UNDOCK_MOVE_SCALE, y: Math.sign(offset.y) * 0.5 * UNDOCK_MOVE_SCALE});
            }
        }
    }

    private registerApplication(uuid: string): void {
        const app: fin.OpenFinApplication = fin.desktop.Application.wrap(uuid);

        // Register main window
        this.addWindow(app.getWindow()).then(window => console.log('Registered app window: ' + window.getId()));

        // Register child windows
        app.getChildWindows((children: fin.OpenFinWindow[]) => {
            children.forEach((child: fin.OpenFinWindow) => {
                this.addWindow(child).then(window => console.log('Registered child window: ' + window.getId()));
            });
        });

        // Listen for future windows
        app.addEventListener('window-created', (event: fin.WindowEvent) => {
            this.addWindow(fin.desktop.Window.wrap(event.uuid, event.name)).then(window => console.log('App created new window: ' + window.getId()));
        });
    }

    private addWindow(window: fin.OpenFinWindow): Promise<SnapWindow> {
        return SnapWindow.getWindowState(window).then<SnapWindow>((state: WindowState): SnapWindow => {
            const group: SnapGroup = this.addGroup();
            const snapWindow: SnapWindow = new SnapWindow(group, window, state);

            snapWindow.onClose.add(this.onWindowClosed, this);
            this.windows.push(snapWindow);

            return snapWindow;
        });
    }

    private addGroup(): SnapGroup {
        const group: SnapGroup = new SnapGroup();
        group.onModified.add(this.validateGroup, this);
        group.onTransform.add(this.snapGroup, this);
        group.onCommit.add(this.applySnapTarget, this);
        group.onWindowRemoved.add(this.onWindowRemovedFromGroup, this);
        group.onWindowAdded.add(this.sendWindowAddedMessage, this);
        this.groups.push(group);
        return group;
    }

    private removeGroup(group: SnapGroup): void {
        const index: number = this.groups.indexOf(group);

        // Can only remove empty groups. Otherwise, things will break.
        if (group.length === 0 && index >= 0) {
            group.onModified.remove(this.validateGroup, this);
            group.onTransform.remove(this.snapGroup, this);
            group.onCommit.remove(this.applySnapTarget, this);
            group.onWindowRemoved.remove(this.onWindowRemovedFromGroup, this);
            group.onWindowAdded.remove(this.sendWindowAddedMessage, this);
            this.groups.splice(index, 1);
        }
    }

    private onWindowClosed(snapWindow: SnapWindow): void {
        const index: number = this.windows.indexOf(snapWindow);

        // NOTE: At this point, snapWindow will belong to a group.
        // SnapGroup also listens to 'onClose' of each of it's windows, and will remove the window from itself.

        // Remove this window from the service
        if (index >= 0) {
            this.windows.splice(index, 1);

            snapWindow.onClose.remove(this.onWindowClosed, this);

            this.validateGroup(snapWindow.getGroup(), snapWindow);
        }
    }

    private onWindowRemovedFromGroup(group: SnapGroup, window: SnapWindow): void {
        if (group.length === 0) {
            // Empty groups are not allowed
            this.removeGroup(group);
        }
        this.sendWindowRemovedMessage(group, window);
    }

    private sendWindowAddedMessage(group: SnapGroup, window: SnapWindow) {
        const identity = window.getIdentity();
        console.log('Window with identity', identity, 'added to group', group);
        this.onWindowAdded.emit(group, window);
    }

    private sendWindowRemovedMessage(group: SnapGroup, window: SnapWindow) {
        const identity = window.getIdentity();
        console.log('Window with identity', identity, 'removed from group', group);
        this.onWindowRemoved.emit(group, window);
    }

    private validateGroup(group: SnapGroup, modifiedWindow: SnapWindow): void {
        // Ensure 'group' is still a valid, contiguous group.
        // NOTE: 'modifiedWindow' may no longer exist (if validation is being performed because a window was closed)

        // TODO (SERVICE-130)
    }

    private snapGroup(activeGroup: SnapGroup, type: Mask<eTransformType>): void {
        const snapTarget: SnapTarget|null = this.resolver.getSnapTarget(this.groups, activeGroup);

        if (snapTarget) {
            console.log('Found snap target: ' + snapTarget.group.windows[0].getId());
        } else {
            console.log('No snap targets');
        }

        this.view.update(activeGroup, snapTarget);
    }

    private applySnapTarget(activeGroup: SnapGroup): void {
        const snapTarget: SnapTarget|null = this.resolver.getSnapTarget(this.groups, activeGroup);

        if (snapTarget && snapTarget.validity === eSnapValidity.VALID && (!(window as Window & {foo: boolean}).foo)) {
            // Move all windows in activeGroup to snapTarget.group
            activeGroup.windows.forEach((window: SnapWindow) => {
                if (window === snapTarget.activeWindow && snapTarget.halfSize) {
                    window.setGroup(snapTarget.group, snapTarget.snapOffset, snapTarget.halfSize);
                } else {
                    window.setGroup(snapTarget.group, snapTarget.snapOffset);
                }
            });

            // The active group should now have been removed (since it is empty)
            if (this.groups.indexOf(activeGroup) >= 0) {
                console.warn(
                    'Expected group to have been removed, but still exists (' + activeGroup.id + ': ' + activeGroup.windows.map(w => w.getId()).join() + ')');
            }
        }

        // Reset view
        this.view.update(null, null);
    }

    private calculateOffset(window: SnapWindow): Point {
        const group = window.getGroup();
        const totalOffset: Point = {x: 0, y: 0};
        for (const groupedWindow of group.windows) {
            // Exclude window being unsnapped
            if (groupedWindow !== window) {
                const distance: MeasureResult = RectUtils.distance(window.getState(), groupedWindow.getState());
                if (distance.minAbs === 0 && distance.min < 0) {
                    totalOffset.x = totalOffset.x + Math.sign((window.getState().center.x - groupedWindow.getState().center.x) * Math.abs(distance.y));
                    totalOffset.y = totalOffset.y + Math.sign((window.getState().center.y - groupedWindow.getState().center.y) * Math.abs(distance.x));
                }
            }
        }
        return totalOffset;
    }
}

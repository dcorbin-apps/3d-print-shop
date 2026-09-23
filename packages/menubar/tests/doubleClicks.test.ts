import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { doubleClicks } from '../src/doubleClicks.js';

describe('doubleClicks', () => {
  const onDoubleClick = jest.fn<() => void>();
  let click: (clickedAt: number) => void;

  beforeEach(() => {
    click = doubleClicks(500, onDoubleClick);
  });

  it('is one click on its own', () => {
    click(1000);
    expect(onDoubleClick).not.toHaveBeenCalled();
  });

  it('is two clicks within the interval, up to and including its end', () => {
    click(1000);
    click(1500);
    expect(onDoubleClick).toHaveBeenCalledTimes(1);
  });

  it('is not two clicks further apart than the interval', () => {
    click(1000);
    click(1501);
    expect(onDoubleClick).not.toHaveBeenCalled();
  });

  it('pairs a late second click with the one after it', () => {
    click(1000);
    click(2000);
    click(2200);
    expect(onDoubleClick).toHaveBeenCalledTimes(1);
  });

  it('counts a triple-click once, and a fourth click completes a second pair', () => {
    click(1000);
    click(1150);
    click(1300);
    expect(onDoubleClick).toHaveBeenCalledTimes(1);
    click(1450);
    expect(onDoubleClick).toHaveBeenCalledTimes(2);
  });
});

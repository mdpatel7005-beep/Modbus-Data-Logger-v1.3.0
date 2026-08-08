import { useState, useEffect } from 'react';
import { RefreshCw, Zap, Plus, ServerCog, Pencil, Trash2, SlidersHorizontal } from 'lucide-react';
import type { ApiAlarmCategory, ApiAlarmCategoryRule, CreateAlarmCategoryRulePayload } from '../lib/api';
import { fetchAlarmCategories, createAlarmCategoryRule, fetchAlarmCategoryRules, updateAlarmCategoryRule, deleteAlarmCategoryRule, fetchAlarmCategoryRuleDetail, fetchAlarmCategoryRuleTags, updateAlarmCategoryRuleTags } from '../lib/api';

export function SectionIntro({
  eyebrow,
  title,
  copy,
  children,
}: {
  eyebrow: string;
  title: string;
  copy: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="section-intro">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h2>{title}</h2>
        <p className="intro-copy">{copy}</p>
      </div>
      {children ? <div className="button-row">{children}</div> : null}
    </div>
  );
}

interface CategoryAlarmsViewProps {
  canConfigure: boolean;
  connected: boolean;
  onToast: (text: string) => void;
  token?: string;
}

export function CategoryAlarmsView({
  canConfigure,
  connected,
  onToast,
  token,
}: CategoryAlarmsViewProps) {
  const [categories, setCategories] = useState<ApiAlarmCategory[]>([]);
  const [selectedCategoryId, setSelectedCategoryId] = useState<string>("");
  const [rules, setRules] = useState<ApiAlarmCategoryRule[]>([]);
  const [loading, setLoading] = useState(connected);

  // Category details (devices/tags) - all registers in the selected category
  const [allCategoryRegisters, setAllCategoryRegisters] = useState<Array<{register_id: string; device_name: string; tag_name: string}>>([]);

  // Modal state for creating/editing rules
  const [showRuleModal, setShowRuleModal] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editingRuleId, setEditingRuleId] = useState<string | null>(null);
  
  // Rule form state (shared between create and edit)
  const [ruleName, setRuleName] = useState("");
  const [ruleSeverity, setRuleSeverity] = useState<"warning" | "critical">("warning");
  const [ruleCondition, setRuleCondition] = useState<'above' | 'below' | 'inside' | 'outside' | 'hi' | 'lo' | 'hii' | 'lolo'>('above');
  const [ruleThresholdHigh, setRuleThresholdHigh] = useState("");
  const [ruleThresholdLow, setRuleThresholdLow] = useState("");
  const [ruleAggregationType, setRuleAggregationType] = useState<'sum' | 'avg' | 'min' | 'max'>('sum');
  const [ruleDeadband, setRuleDeadband] = useState("0");
  
  // Device selection within rule (empty = use ALL devices in category)
  const [selectedDeviceIds, setSelectedDeviceIds] = useState<string[]>([]);

  useEffect(() => {
    if (!connected) return;
    let active = true;
    
    async function loadCategories() {
      try {
        const response = await fetchAlarmCategories(token);
        if (active) setCategories(response.items || []);
        
        // Auto-select first category if none selected
        if (response.items && response.items.length > 0 && !selectedCategoryId) {
          setSelectedCategoryId(response.items[0].id);
        }
      } catch {
        // Silently handle error
      } finally {
        if (active) setLoading(false);
      }
    }
    
    loadCategories();
    return () => { active = false; };
  }, [connected, token]);

  useEffect(() => {
    if (!selectedCategoryId || !connected) return;
    let active = true;
    
    async function loadCategoryRegisters() {
      try {
        const detail = await fetchAlarmCategoryRuleDetail(selectedCategoryId, token);
        if (active && detail.matchingRegisters) {
          setAllCategoryRegisters(detail.matchingRegisters.map((r: any) => ({
            register_id: r.register_id,
            device_name: r.device_name,
            tag_name: r.tag_name
          })));
        }
      } catch {
        // Silently handle error
      }
    }
    
    loadCategoryRegisters();
    return () => { active = false; };
  }, [selectedCategoryId, connected]);

  useEffect(() => {
    if (!selectedCategoryId || !connected) return;
    let active = true;
    
    async function loadRules() {
      try {
        const response = await fetchAlarmCategoryRules(selectedCategoryId, token);
        if (active) setRules(response.items || []);
      } catch {
        // Silently handle error
      }
    }
    
    loadRules();
    return () => { active = false; };
  }, [selectedCategoryId, connected, token]);

  async function createRule() {
    if (!ruleName.trim()) {
      onToast("Rule name is required");
      return;
    }
    
    const payload: CreateAlarmCategoryRulePayload = {
      name: ruleName,
      severity: ruleSeverity,
      condition: ruleCondition,
      thresholdHigh: ruleThresholdHigh ? parseFloat(ruleThresholdHigh) : null,
      thresholdLow: ruleThresholdLow ? parseFloat(ruleThresholdLow) : null,
      aggregationType: ruleAggregationType,
      deadband: ruleDeadband ? parseFloat(ruleDeadband) : 0,
    };
    
    try {
      const rule = await createAlarmCategoryRule(selectedCategoryId, payload, token);
      
      // Save selected tags if any
      if (selectedDeviceIds.length > 0 && rule.id) {
        await updateAlarmCategoryRuleTags(rule.id, selectedDeviceIds, token);
      }
      
      onToast("Category alarm rule created successfully");
      setShowRuleModal(false);
      resetForm();
      setSelectedDeviceIds([]);
      
      // Refresh rules list
      const response = await fetchAlarmCategoryRules(selectedCategoryId, token);
      setRules(response.items || []);
    } catch (error) {
      onToast(error instanceof ApiError ? error.message : "Failed to create alarm rule");
    }
  }

  async function deleteRule(ruleId: string) {
    if (!confirm("Delete this category alarm rule?")) return;
    
    try {
      await deleteAlarmCategoryRule(ruleId, token);
      onToast("Alarm rule deleted");
      
      // Refresh rules list
      const response = await fetchAlarmCategoryRules(selectedCategoryId, token);
      setRules(response.items || []);
    } catch (error) {
      onToast(error instanceof ApiError ? error.message : "Failed to delete alarm rule");
    }
  }

  async function updateRule() {
    if (!editingRuleId || !ruleName.trim()) {
      onToast("Rule name is required");
      return;
    }
    
    const payload: Partial<CreateAlarmCategoryRulePayload> = {
      name: ruleName,
      severity: ruleSeverity,
      condition: ruleCondition,
      thresholdHigh: ruleThresholdHigh ? parseFloat(ruleThresholdHigh) : null,
      thresholdLow: ruleThresholdLow ? parseFloat(ruleThresholdLow) : null,
      aggregationType: ruleAggregationType,
      deadband: ruleDeadband ? parseFloat(ruleDeadband) : 0,
    };
    
    try {
      await updateAlarmCategoryRule(editingRuleId, payload as CreateAlarmCategoryRulePayload, token);
      
      // Save selected tags if any
      if (selectedDeviceIds.length > 0) {
        await updateAlarmCategoryRuleTags(editingRuleId, selectedDeviceIds, token);
      } else {
        // Clear all tags if none selected (use ALL devices)
        await updateAlarmCategoryRuleTags(editingRuleId, [], token);
      }
      
      onToast("Alarm rule updated successfully");
      setShowRuleModal(false);
      setIsEditing(false);
      setEditingRuleId(null);
      setSelectedDeviceIds([]);
      
      // Refresh rules list
      const response = await fetchAlarmCategoryRules(selectedCategoryId, token);
      setRules(response.items || []);
    } catch (error) {
      onToast(error instanceof ApiError ? error.message : "Failed to update alarm rule");
    }
  }

  function handleEditRule(rule: ApiAlarmCategoryRule) {
    setIsEditing(true);
    setEditingRuleId(rule.id);
    setRuleName(rule.name);
    setRuleSeverity(rule.severity);
    setRuleCondition(rule.condition as 'above' | 'below' | 'inside' | 'outside' | 'hi' | 'lo' | 'hii' | 'lolo');
    setRuleThresholdHigh(rule.threshold_high != null ? rule.threshold_high.toString() : "");
    setRuleThresholdLow(rule.threshold_low != null ? rule.threshold_low.toString() : "");
    setRuleAggregationType(rule.aggregation_type as 'sum' | 'avg' | 'min' | 'max');
    setRuleDeadband((rule.deadband ?? 0).toString());
    
    // Load tags for this rule
    loadRuleTags(rule.id);
    
    setShowRuleModal(true);
  }

  async function loadRuleTags(ruleId: string) {
    try {
      const response = await fetchAlarmCategoryRuleTags(ruleId, token);
      if (response.items && response.items.length > 0) {
        setSelectedDeviceIds(response.items);
      } else {
        setSelectedDeviceIds([]); // Empty means use ALL devices
      }
    } catch {
      setSelectedDeviceIds([]);
    }
  }

  function resetForm() {
    setRuleName("");
    setRuleSeverity("warning");
    setRuleCondition('above');
    setRuleThresholdHigh("");
    setRuleThresholdLow("");
    setRuleAggregationType('sum');
    setRuleDeadband("0");
  }

  const aggregationLabels = {
    sum: "Sum",
    avg: "Average",
    min: "Minimum",
    max: "Maximum"
  };

  if (!connected) return <div className="text-red-600 font-semibold">Disconnected</div>;
  
  if (loading) {
    return (
      <section className="dashboard-section">
        <div className="empty-state">
          <RefreshCw size={24} className="animate-spin" />
          <div>Loading categories...</div>
        </div>
      </section>
    );
  }

  if (categories.length === 0) {
    return (
      <section className="dashboard-section">
        <SectionIntro
          eyebrow="Category Aggregation"
          title="Category Total Threshold Alarms"
          copy="Create alarm rules that automatically aggregate values across ALL devices/tags within a category. For example, sum current readings from 3 meters and trigger an alert if the total exceeds a threshold."
        />
        <div className="empty-state compact-empty-state">
          <div>
            <span className="empty-state-icon future-alert-icon">
              <Zap size={21} />
            </span>
            <h3>No categories configured</h3>
            <p>Create device categories first in the Devices view, then assign devices to categories. Category Total Alarms will aggregate values across all devices in a category.</p>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="dashboard-section">
      <SectionIntro
        eyebrow="Category Aggregation"
        title="Category Total Threshold Alarms"
        copy="Create alarm rules that automatically aggregate values across ALL devices/tags within a category. For example, sum current readings from 3 meters and trigger an alert if the total exceeds a threshold."
      >
        <button
          className="button primary"
          disabled={!connected || !selectedCategoryId}
          onClick={() => {
            setIsEditing(false);
            resetForm();
            setSelectedDeviceIds([]);
            setShowRuleModal(true);
          }}
          type="button"
        >
          <Plus size={14} />
          Create Category Alarm Rule
        </button>
      </SectionIntro>

      {/* Category Selector */}
      <div className="card">
        <label className="form-label">Select a Category</label>
        <select
          value={selectedCategoryId}
          onChange={(e) => setSelectedCategoryId(e.target.value)}
          className="input"
          disabled={!connected}
        >
          {categories.map((category) => (
            <option key={category.id} value={category.id}>
              {category.name} ({category.device_count} devices)
            </option>
          ))}
        </select>
      </div>

      {/* Rules List - shown when category selected */}
      {selectedCategoryId && (
        <section className="dashboard-section">
          <h2 className="section-title">
            Category Alarms for: {categories.find(c => c.id === selectedCategoryId)?.name || "Unknown"}
            {!canConfigure && (
              <span className="permission-banner" style={{ marginLeft: '1rem' }}>
                Read-only mode
              </span>
            )}
          </h2>

          {rules.length === 0 ? (
            <div className="empty-state compact-empty-state">
              <p>No category alarm rules configured for this category yet. Create one to set thresholds based on aggregated values.</p>
            </div>
          ) : (
            <div className="card-grid">
              {rules.map((rule) => (
                <div key={rule.id} className="dashboard-card">
                  <div className="card-header">
                    <h3>{rule.name}</h3>
                    {canConfigure && (
                      <div className="flex gap-2">
                        <button
                          className="icon-button"
                          onClick={() => handleEditRule(rule)}
                          title="Edit rule"
                        >
                          <Pencil size={16} />
                        </button>
                        <button
                          className="icon-button text-red-500"
                          onClick={() => deleteRule(rule.id)}
                          title="Delete rule"
                        >
                          <Trash2 size={16} />
                        </button>
                      </div>
                    )}
                  </div>
                  <div className="card-body">
                    <div className="meta-grid">
                      <div className="meta-item">
                        <span className="meta-label">Severity</span>
                        <span className={`severity-badge severity-${rule.severity}`}>
                          {rule.severity}
                        </span>
                      </div>
                      <div className="meta-item">
                        <span className="meta-label">Condition</span>
                        <span>{rule.condition}</span>
                      </div>
                      <div className="meta-item">
                        <span className="meta-label">Aggregation</span>
                        <span>{aggregationLabels[rule.aggregation_type]}</span>
                      </div>
                      {rule.threshold_high !== null && (
                        <div className="meta-item">
                          <span className="meta-label">Threshold High</span>
                          <span>{rule.threshold_high}</span>
                        </div>
                      )}
                      {rule.threshold_low !== null && (
                        <div className="meta-item">
                          <span className="meta-label">Threshold Low</span>
                          <span>{rule.threshold_low}</span>
                        </div>
                      )}
                      {rule.deadband > 0 && (
                        <div className="meta-item">
                          <span className="meta-label">Deadband</span>
                          <span>{rule.deadband}</span>
                        </div>
                      )}
                    </div>

                    {/* Device Selection Summary */}
                    <div className="mt-3 pt-3 border-t border-gray-200">
                      <h4 className="text-xs font-semibold text-gray-600 uppercase tracking-wide mb-2 flex items-center gap-1.5">
                        <ServerCog size={14} />
                        Devices Participating
                      </h4>
                      
                      {allCategoryRegisters.length === 0 ? (
                        <p className="text-xs text-gray-500 italic">No devices in this category</p>
                      ) : (() => {
                        // Group registers by device for display
                        const grouped = new Map<string, number>();
                        allCategoryRegisters.forEach(r => {
                          grouped.set(r.device_name, (grouped.get(r.device_name) || 0) + 1);
                        });

                        return (
                          <div className="space-y-1">
                            {Array.from(grouped.entries()).map(([deviceName, count]) => (
                              <div key={deviceName} className="flex items-center gap-2 text-sm py-1 px-2 bg-gray-50 rounded">
                                <span className="font-medium truncate">{deviceName}</span>
                                <span className="text-xs text-gray-500 flex-shrink-0">({count} tag{count !== 1 ? 's' : ''})</span>
                              </div>
                            ))}
                          </div>
                        );
                      })()}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {/* Create/Edit Rule Modal */}
      {showRuleModal && (
        <div className="modal-backdrop" onClick={() => setShowRuleModal(false)}>
          <div className="card modal-card" onClick={(e) => e.stopPropagation()}>
            <h2>{isEditing ? 'Edit' : 'Create'} Category Alarm Rule</h2>
            
            <form onSubmit={(e) => {
              e.preventDefault();
              if (isEditing) {
                updateRule();
              } else {
                createRule();
              }
            }}>
              <div className="form-group">
                <label className="form-label">Rule Name *</label>
                <input
                  type="text"
                  value={ruleName}
                  onChange={(e) => setRuleName(e.target.value)}
                  placeholder="e.g., Total Current Exceeded"
                  className="input"
                  required
                />
              </div>

              <div className="form-group">
                <label className="form-label">Severity</label>
                <select
                  value={ruleSeverity}
                  onChange={(e) => setRuleSeverity(e.target.value as "warning" | "critical")}
                  className="input"
                >
                  <option value="warning">Warning</option>
                  <option value="critical">Critical</option>
                </select>
              </div>

              <div className="form-group">
                <label className="form-label">Condition</label>
                <select
                  value={ruleCondition}
                  onChange={(e) => setRuleCondition(e.target.value as 'above' | 'below' | 'inside' | 'outside' | 'hi' | 'lo' | 'hii' | 'lolo')}
                  className="input"
                >
                  <option value="above">Above</option>
                  <option value="below">Below</option>
                  <option value="inside">Inside Range</option>
                  <option value="outside">Outside Range</option>
                  <option value="hi">Hi (Single Threshold)</option>
                  <option value="lo">Lo (Single Threshold)</option>
                  <option value="hii">HIHI (Double Hi)</option>
                  <option value="lolo">LOLO (Double Lo)</option>
                </select>
              </div>

              {['above', 'below', 'hi', 'lo'].includes(ruleCondition) && (
                <div className="form-group">
                  <label className="form-label">Threshold</label>
                  <input
                    type="number"
                    value={ruleCondition === 'below' || ruleCondition === 'lo' ? ruleThresholdLow : ruleThresholdHigh}
                    onChange={(e) => {
                      if (ruleCondition === 'below' || ruleCondition === 'lo') {
                        setRuleThresholdLow(e.target.value);
                      } else {
                        setRuleThresholdHigh(e.target.value);
                      }
                    }}
                    placeholder="Enter threshold value"
                    className="input"
                  />
                </div>
              )}

              {['inside', 'outside'].includes(ruleCondition) && (
                <div className="form-group">
                  <label className="form-label">Threshold Range</label>
                  <input
                    type="number"
                    value={ruleThresholdLow}
                    onChange={(e) => setRuleThresholdLow(e.target.value)}
                    placeholder="Lower threshold"
                    className="input"
                  />
                  <input
                    type="number"
                    value={ruleThresholdHigh}
                    onChange={(e) => setRuleThresholdHigh(e.target.value)}
                    placeholder="Upper threshold"
                    className="input"
                  />
                </div>
              )}

              {['hii', 'lolo'].includes(ruleCondition) && (
                <div className="form-group">
                  <label className="form-label">Dual Thresholds</label>
                  <input
                    type="number"
                    value={ruleThresholdLow}
                    onChange={(e) => setRuleThresholdLow(e.target.value)}
                    placeholder={ruleCondition === 'hii' ? "Lower hi threshold" : "Upper lo threshold"}
                    className="input"
                  />
                  <input
                    type="number"
                    value={ruleThresholdHigh}
                    onChange={(e) => setRuleThresholdHigh(e.target.value)}
                    placeholder={ruleCondition === 'hii' ? "Upper hi threshold" : "Lower lo threshold"}
                    className="input"
                  />
                </div>
              )}

              <div className="form-group">
                <label className="form-label">Aggregation Type</label>
                <select
                  value={ruleAggregationType}
                  onChange={(e) => setRuleAggregationType(e.target.value as 'sum' | 'avg' | 'min' | 'max')}
                  className="input"
                >
                  <option value="sum">Sum (Total)</option>
                  <option value="avg">Average</option>
                  <option value="min">Minimum</option>
                  <option value="max">Maximum</option>
                </select>
              </div>

              {/* Device/Tag Selection - Prominent Section */}
              <div className="form-group">
                <div className="flex items-center justify-between mb-2">
                  <label className="text-sm font-semibold text-gray-700 flex items-center gap-1.5">
                    <ServerCog size={16} />
                    Devices in Alarm
                  </label>
                  {selectedDeviceIds.length > 0 && (
                    <span className="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full font-medium">
                      {selectedDeviceIds.length} selected
                    </span>
                  )}
                </div>
                <p className="text-sm text-gray-600 mb-3">Choose which devices participate in this alarm. Leave empty to use ALL devices.</p>

                {/* Quick-select buttons */}
                <div className="flex gap-2 mb-3">
                  <button
                    type="button"
                    onClick={() => setSelectedDeviceIds(allCategoryRegisters.map(r => r.register_id))}
                    className="text-xs px-2 py-1 bg-gray-100 hover:bg-gray-200 rounded text-gray-700 cursor-pointer"
                  >
                    Select All ({allCategoryRegisters.length})
                  </button>
                  <button
                    type="button"
                    onClick={() => setSelectedDeviceIds([])}
                    className="text-xs px-2 py-1 bg-gray-100 hover:bg-gray-200 rounded text-red-600 cursor-pointer"
                  >
                    Clear All
                  </button>
                  <span className="text-xs text-gray-400 self-center">|</span>
                  <label className="flex items-center gap-1.5 text-xs text-gray-600 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={selectedDeviceIds.length === 0}
                      onChange={(e) => {
                        if (e.target.checked) setSelectedDeviceIds([]);
                      }}
                      className="cursor-pointer"
                    />
                    Use ALL devices (default)
                  </label>
                </div>

                {/* Device List - grouped by device */}
                <div className="max-h-64 overflow-y-auto border border-gray-200 rounded p-2 bg-gray-50">
                  {allCategoryRegisters.length === 0 ? (
                    <p className="text-xs text-gray-500 italic">No devices in this category</p>
                  ) : (() => {
                    const grouped = new Map<string, Array<{register_id: string; tag_name: string}>>();
                    allCategoryRegisters.forEach(r => {
                      if (!grouped.has(r.device_name)) grouped.set(r.device_name, []);
                      grouped.get(r.device_name)!.push({ register_id: r.register_id, tag_name: r.tag_name });
                    });

                    return (
                      <div className="space-y-2">
                        {Array.from(grouped.entries()).map(([deviceName, tags]) => (
                          <div key={deviceName} className="border border-gray-200 rounded p-2 bg-white">
                            <h5 className="text-xs font-semibold text-gray-700 mb-1">{deviceName}</h5>
                            <div className="space-y-1">
                              {tags.map(tag => (
                                <label key={tag.register_id} className="flex items-center gap-2 text-sm cursor-pointer hover:bg-gray-50 rounded px-1 py-0.5 -ml-1">
                                  <input
                                    type="checkbox"
                                    checked={selectedDeviceIds.includes(tag.register_id)}
                                    onChange={(e) => {
                                      if (e.target.checked) {
                                        setSelectedDeviceIds(prev => [...prev, tag.register_id]);
                                      } else {
                                        setSelectedDeviceIds(prev => prev.filter(id => id !== tag.register_id));
                                      }
                                    }}
                                    className="cursor-pointer"
                                  />
                                  <span className="truncate">{tag.tag_name}</span>
                                </label>
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>
                    );
                  })()}
                </div>

                {/* Show selected tags summary */}
                {selectedDeviceIds.length > 0 && (
                  <div className="mt-3 p-2 bg-blue-50 border border-blue-200 rounded">
                    <h5 className="text-xs font-semibold text-blue-700 mb-1">Selected Devices ({selectedDeviceIds.length})</h5>
                    <div className="flex flex-wrap gap-1">
                      {allCategoryRegisters
                        .filter(r => selectedDeviceIds.includes(r.register_id))
                        .map(r => (
                          <span key={r.register_id} className="text-xs bg-blue-100 text-blue-800 px-2 py-0.5 rounded-full truncate max-w-[200px]">
                            {r.device_name}: {r.tag_name}
                          </span>
                        ))}
                    </div>
                  </div>
                )}
              </div>

              <div className="form-group bg-gray-50 p-3 rounded-lg border border-gray-200">
                <label className="font-medium mb-1 block flex items-center gap-2">
                  <SlidersHorizontal size={14} /> Deadband (optional)
                </label>
                <input type="number" value={ruleDeadband} onChange={(e) => setRuleDeadband(e.target.value)} placeholder="0" min="0" step="0.01" className="w-full p-2 border border-gray-300 rounded" />
                <p className="text-xs text-muted mt-1">Value range to prevent alarm re-triggering after acknowledgment</p>
              </div>

              <div className="button-row mt-6 pt-4 border-t border-gray-100">
                <button type="button" className="button secondary" onClick={() => setShowRuleModal(false)}>Cancel</button>
                <button type="submit" className="button primary">{isEditing ? 'Update Rule' : 'Create Rule'}</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </section>
  );
}
